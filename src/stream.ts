/**
 * stream.ts — Stream handler for CommandCode /alpha/generate.
 *
 * THIS MODULE'S SINGLE RESPONSIBILITY:
 *   Orchestrate the full request/response lifecycle:
 *     1. Build the request payload (using helpers from other modules)
 *     2. Make the HTTP POST to /alpha/generate
 *     3. Read the SSE stream and emit Pi AssistantMessage events
 *
 * It delegates:
 *   - Message conversion    → message-converter.ts
 *   - History cleaning      → history-cleaner.ts
 *   - SSE line parsing      → sse-parser.ts
 *   - Utilities (freeze, headers, cost) → utils.ts
 */

import { randomUUID } from "node:crypto";

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

import {
  COMMANDCODE_GENERATE_URL,
  STATIC_CONFIG,
  STATIC_SYSTEM_PROMPT,
  buildHeaders,
  freezeTools,
  getModelCost,
  promptTo256Padding,
  countTokens,
  deterministicStringify,
} from "./utils.js";

import type { CCEvent } from "./sse-types.js";
import { parseEventLine } from "./sse-parser.js";
import { messagesToCC } from "./message-converter.js";
import { cleanHistoryForCache } from "./history-cleaner.js";

// ── Session-scoped thread ID (generated once per module load) ──
const SESSION_THREAD_ID = randomUUID();

// ---------------------------------------------------------------------------
// SSE event processor — encapsulates mutable streaming state
// ---------------------------------------------------------------------------

class SSEProcessor {
  private textBlock: { type: "text"; text: string } | undefined;
  private textIdx = -1;
  private thinkingIdx = -1;

  constructor(
    private readonly stream: AssistantMessageEventStream,
    private readonly output: AssistantMessage,
    private readonly model: Model<any>,
  ) {}

  emitStart(): void {
    this.stream.push({ type: "start", partial: this.output });
  }

  emitDone(): void {
    if (this.output.stopReason === "stop" && this.output.content.length === 0) {
      this.output.stopReason = "stop";
    }
    this.stream.push({
      type: "done",
      reason: this.output.stopReason as "stop" | "length" | "toolUse",
      message: this.output,
    });
    this.stream.end();
  }

  emitError(error: unknown): void {
    this.output.stopReason = "error";
    this.output.errorMessage =
      error instanceof Error ? error.message : String(error);
    this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    this.stream.end();
  }

  private endText(): void {
    if (this.textBlock) {
      this.stream.push({
        type: "text_end",
        contentIndex: this.textIdx,
        content: this.textBlock.text,
        partial: this.output,
      });
      this.textBlock = undefined;
      this.textIdx = -1;
    }
  }

  private endThinking(): void {
    if (this.thinkingIdx >= 0) {
      this.stream.push({
        type: "thinking_end",
        contentIndex: this.thinkingIdx,
        content:
          (this.output.content[this.thinkingIdx] as any)?.thinking ?? "",
        partial: this.output,
      });
      this.thinkingIdx = -1;
    }
  }

  /** Process a single SSE event. Returns true when the stream signals finish. */
  handleEvent(evt: CCEvent): boolean {
    switch (evt.type) {
      case "text-delta": {
        this.endThinking();
        if (!this.textBlock) {
          this.textBlock = { type: "text", text: "" };
          this.output.content.push(this.textBlock);
          this.textIdx = this.output.content.length - 1;
          this.stream.push({
            type: "text_start",
            contentIndex: this.textIdx,
            partial: this.output,
          });
        }
        const delta = evt.text ?? "";
        this.textBlock.text += delta;
        this.stream.push({
          type: "text_delta",
          contentIndex: this.textIdx,
          delta,
          partial: this.output,
        });
        return false;
      }

      case "reasoning-start": {
        this.endText();
        return false;
      }

      case "reasoning-delta": {
        this.endText();
        const delta = evt.text ?? "";
        if (this.thinkingIdx < 0) {
          this.output.content.push({
            type: "thinking",
            thinking: delta,
          } as any);
          this.thinkingIdx = this.output.content.length - 1;
          this.stream.push({
            type: "thinking_start",
            contentIndex: this.thinkingIdx,
            partial: this.output,
          });
        } else {
          const tc = this.output.content[this.thinkingIdx] as any;
          if (tc) tc.thinking = (tc.thinking ?? "") + delta;
        }
        this.stream.push({
          type: "thinking_delta",
          contentIndex: this.thinkingIdx,
          delta,
          partial: this.output,
        });
        return false;
      }

      case "reasoning-end": {
        this.endThinking();
        return false;
      }

      case "tool-call": {
        this.endText();
        this.endThinking();
        const toolCall = {
          type: "toolCall" as const,
          id: evt.toolCallId ?? "",
          name: evt.toolName ?? "",
          arguments: resolveToolArgs(evt),
        };
        this.output.content.push(toolCall);
        const idx = this.output.content.length - 1;
        this.stream.push({
          type: "toolcall_start",
          contentIndex: idx,
          partial: this.output,
        });
        this.stream.push({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall,
          partial: this.output,
        });
        return false;
      }

      case "tool-result": {
        return false;
      }

      case "finish": {
        const usage = evt.totalUsage;
        if (usage) {
          populateUsage(this.output, this.model, usage);
        }
        this.output.stopReason = mapFinishReason(evt.finishReason);
        return true;
      }

      case "error": {
        const errMsg =
          typeof evt.error === "string"
            ? evt.error
            : (evt.error as any)?.message ?? "Stream error";
        throw new Error(errMsg);
      }

      default:
        return false;
    }
  }

  /** Flush any pending text/thinking blocks. */
  finalize(): void {
    this.endText();
    this.endThinking();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function streamCommandCode(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = createEmptyOutput(model);

  // Run the async lifecycle in the background, emitting events to the stream.
  // Errors are already handled inside runStreamLifecycle; we silence unhandled
  // rejections here since they would be a double-report.
  (async () => {
    try {
      await runStreamLifecycle(stream, output, model, context, options);
    } catch {
      // Error already handled inside runStreamLifecycle
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Async stream lifecycle
// ---------------------------------------------------------------------------

async function runStreamLifecycle(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  const processor = new SSEProcessor(stream, output, model);

  try {
    const apiKey = resolveApiKey(options);

    // 1. Build request payload
    const body = buildRequestBody(model, context, options);
    const bodyStr = deterministicStringify(body);

    logPayloadTelemetry(bodyStr);

    // 2. HTTP POST
    const response = await fetch(COMMANDCODE_GENERATE_URL, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: bodyStr,
      signal: options?.signal,
    });

    if (!response.ok) {
      let errBody = "";
      try {
        errBody = await response.text();
      } catch {
        // ignore parse failure
      }
      throw new Error(
        `CommandCode API error ${response.status}: ${errBody.slice(0, 500)}`,
      );
    }

    // 3. Read SSE stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    await processSSEStream(reader, processor);

    // Finalize
    processor.finalize();
    processor.emitDone();
  } catch (error) {
    if (options?.signal?.aborted) {
      output.stopReason = "aborted";
    }
    processor.emitError(error);
  }
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function buildRequestBody(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): Record<string, unknown> {
  // 1. Prune old thinking blocks
  const cleanedMessages = cleanHistoryForCache(context.messages);

  // 2. Convert to CommandCode format
  const ccMessages = messagesToCC(cleanedMessages);

  // 3. System prompt (static, padded for cache alignment)
  const paddedSystem = promptTo256Padding(STATIC_SYSTEM_PROMPT);

  const params: Record<string, any> = {
    model: model.id,
    messages: ccMessages,
    tools: context.tools ? freezeTools(context.tools) : [],
    system: paddedSystem,
    max_tokens: 8192,
    temperature: 0.3,
    stream: true,
  };

  // Reasoning / thinking
  if (options?.reasoning && model.reasoning) {
    params.thinking = {
      type: "enabled",
      budget_tokens: parseInt(
        model.thinkingLevelMap?.[options.reasoning] ?? "2048",
        10,
      ),
    };
  }

  return {
    config: STATIC_CONFIG,
    memory: null,
    taste: null,
    skills: null,
    cache_prompt: true,
    disable_backend_formatting: true,
    params,
    threadId: SESSION_THREAD_ID,
  };
}

// ---------------------------------------------------------------------------
// SSE stream processor
// ---------------------------------------------------------------------------

async function processSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  processor: SSEProcessor,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  processor.emitStart();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      // Flush final buffer
      if (buffer.trim()) {
        const evt = parseEventLine(buffer);
        if (evt) processor.handleEvent(evt);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const evt = parseEventLine(line);
      if (evt) {
        const shouldStop = processor.handleEvent(evt);
        if (shouldStop) {
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (private to this module)
// ---------------------------------------------------------------------------

function createEmptyOutput(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function resolveApiKey(options?: SimpleStreamOptions): string {
  const apiKey = options?.apiKey ?? "";
  if (!apiKey || apiKey.startsWith("$")) {
    throw new Error(
      "No CommandCode API key. Set COMMANDCODE_API_KEY env var or pass --api-key.",
    );
  }
  return apiKey;
}

function logPayloadTelemetry(bodyStr: string): void {
  const totalTokens = countTokens(bodyStr);
  console.log(
    `\x1b[36m[CleanCache]\x1b[0m Payload: ${totalTokens} tokens | ` +
      `Aligned to 256: ${totalTokens % 256 === 0 ? "✅ YES" : "❌ NO (remainder " + totalTokens % 256 + ")"}`,
  );
}

function resolveToolArgs(
  evt: CCEvent & { type: "tool-call" },
): Record<string, unknown> {
  const raw = evt.args ?? evt.input ?? evt.arguments ?? {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw !== null) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function populateUsage(
  output: AssistantMessage,
  model: Model<any>,
  usage: Record<string, unknown>,
): void {
  const details = (usage as any).inputTokenDetails;
  output.usage.input = (usage as any).inputTokens ?? 0;
  output.usage.output = (usage as any).outputTokens ?? 0;
  output.usage.cacheRead = details?.cacheReadTokens ?? 0;
  output.usage.cacheWrite = details?.cacheWriteTokens ?? 0;
  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite;

  const cost = getModelCost(model.id);
  output.usage.cost = {
    input: (output.usage.input / 1_000_000) * cost.input,
    output: (output.usage.output / 1_000_000) * cost.output,
    cacheRead: (output.usage.cacheRead / 1_000_000) * cost.cacheRead,
    cacheWrite: (output.usage.cacheWrite / 1_000_000) * cost.cacheWrite,
    total: 0,
  };
  output.usage.cost.total =
    output.usage.cost.input +
    output.usage.cost.output +
    output.usage.cost.cacheRead +
    output.usage.cost.cacheWrite;
}

function mapFinishReason(
  reason: unknown,
): "stop" | "length" | "toolUse" | "error" {
  if (reason === "tool-calls") return "toolUse";
  if (
    reason === "length" ||
    reason === "max_tokens" ||
    reason === "max-tokens" ||
    reason === "max_output_tokens"
  ) {
    return "length";
  }
  if (reason === "stop" || reason === "end_turn") return "stop";
  return "stop";
}
