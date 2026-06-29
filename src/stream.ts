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
// Public API
// ---------------------------------------------------------------------------

export function streamCommandCode(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output = createEmptyOutput(model);

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
        const errBody = await response.text().catch(() => "");
        throw new Error(
          `CommandCode API error ${response.status}: ${errBody.slice(0, 500)}`,
        );
      }

      // 3. Read SSE stream
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      await processSSEStream(reader, stream, output, model);

      // Finalize
      if (output.stopReason === "stop" && output.content.length === 0) {
        output.stopReason = "stop";
      }

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
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
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model: Model<any>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  // Mutable state shared with event handler
  let textBlock: { type: "text"; text: string } | undefined;
  let textIdx = -1;
  let thinkingIdx = -1;

  const endText = () => {
    if (textBlock) {
      stream.push({
        type: "text_end",
        contentIndex: textIdx,
        content: textBlock.text,
        partial: output,
      });
      textBlock = undefined;
      textIdx = -1;
    }
  };

  const endThinking = () => {
    if (thinkingIdx >= 0) {
      stream.push({
        type: "thinking_end",
        contentIndex: thinkingIdx,
        content:
          (output.content[thinkingIdx] as any)?.thinking ?? "",
        partial: output,
      });
      thinkingIdx = -1;
    }
  };

  // Event handler closes over the shared state
  const handleEvent = (evt: CCEvent): boolean => {
    switch (evt.type) {
      case "text-delta": {
        endThinking();
        if (!textBlock) {
          textBlock = { type: "text", text: "" };
          output.content.push(textBlock);
          textIdx = output.content.length - 1;
          stream.push({
            type: "text_start",
            contentIndex: textIdx,
            partial: output,
          });
        }
        const delta = evt.text ?? "";
        textBlock.text += delta;
        stream.push({
          type: "text_delta",
          contentIndex: textIdx,
          delta,
          partial: output,
        });
        return false;
      }

      case "reasoning-start": {
        endText();
        return false;
      }

      case "reasoning-delta": {
        endText();
        const delta = evt.text ?? "";
        if (thinkingIdx < 0) {
          output.content.push({
            type: "thinking",
            thinking: delta,
          } as any);
          thinkingIdx = output.content.length - 1;
          stream.push({
            type: "thinking_start",
            contentIndex: thinkingIdx,
            partial: output,
          });
        } else {
          const tc = output.content[thinkingIdx] as any;
          if (tc) tc.thinking = (tc.thinking ?? "") + delta;
        }
        stream.push({
          type: "thinking_delta",
          contentIndex: thinkingIdx,
          delta,
          partial: output,
        });
        return false;
      }

      case "reasoning-end": {
        endThinking();
        return false;
      }

      case "tool-call": {
        endText();
        endThinking();
        const toolCall = {
          type: "toolCall" as const,
          id: evt.toolCallId ?? "",
          name: evt.toolName ?? "",
          arguments: resolveToolArgs(evt),
        };
        output.content.push(toolCall);
        const idx = output.content.length - 1;
        stream.push({
          type: "toolcall_start",
          contentIndex: idx,
          partial: output,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall,
          partial: output,
        });
        return false;
      }

      case "tool-result": {
        return false;
      }

      case "finish": {
        const usage = evt.totalUsage;
        if (usage) {
          populateUsage(output, model, usage);
        }
        output.stopReason = mapFinishReason(evt.finishReason);
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
  };

  stream.push({ type: "start", partial: output });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      // Flush final buffer
      if (buffer.trim()) {
        const evt = parseEventLine(buffer);
        if (evt) handleEvent(evt);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const evt = parseEventLine(line);
      if (evt) {
        const shouldStop = handleEvent(evt);
        if (shouldStop) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
  }

  endText();
  endThinking();
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
