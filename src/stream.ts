/**
 * Cache‑optimised stream for the CommandCode API (non‑standard protocol).
 *
 * The CommandCode API at POST /alpha/generate uses a custom JSON body and
 * SSE‑like event stream.  This implementation:
 *
 *  1.  FREEZES the config object so it's byte‑identical every request.
 *  2.  FREEZES the system prompt (STATIC_SYSTEM_PROMPT).
 *  3.  FREEZES the tool definitions (sorted, stripped).
 *  4.  Disables the Taste‑1 tracking loop (x-taste-learning: false).
 *  5.  Uses a static project slug.
 *
 * Result: every request shares a byte‑identical prefix → DeepSeek
 * prefix caching hits at 87‑99% instead of ~30%.
 */

import { randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  calculateCost,
  createAssistantMessageEventStream,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  COMMANDCODE_GENERATE_URL,
  STATIC_CONFIG,
  STATIC_SYSTEM_PROMPT,
  buildHeaders,
  freezeTools,
  getModelCost,
  sanitise,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Types for the CommandCode SSE event stream
// ---------------------------------------------------------------------------
type CCEvent =
  | { type: "text-delta"; text?: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text?: string }
  | { type: "reasoning-end" }
  | { type: "tool-call"; toolCallId?: string; toolName?: string; args?: unknown; input?: unknown; arguments?: unknown }
  | { type: "tool-result" }
  | { type: "finish"; finishReason?: string; totalUsage?: Record<string, unknown> }
  | { type: "error"; error?: unknown };

// ---------------------------------------------------------------------------
// Convert Pi messages → CommandCode message format
// ---------------------------------------------------------------------------
function messagesToCC(messages: readonly Message[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c) =>
                c.type === "text" ? { type: "text", text: sanitise(c.text) } : c,
              )
            : msg.content;
      out.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const parts: unknown[] = [];
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          parts.push({ type: "text", text: sanitise(block.text) });
        } else if (block.type === "thinking" && (block as any).thinking) {
          parts.push({ type: "reasoning", text: sanitise((block as any).thinking) });
        } else if (block.type === "toolCall") {
          parts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.arguments,
          });
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts });
    } else if (msg.role === "toolResult") {
      const tr = msg as ToolResultMessage;
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            output: tr.isError
              ? { type: "error-text", value: extractText(tr) }
              : { type: "text", value: extractText(tr) },
          },
        ],
      });
    }
  }
  return out;
}

function extractText(msg: ToolResultMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Parse a single SSE line from CommandCode
// ---------------------------------------------------------------------------
function parseEventLine(line: string): CCEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
  const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as CCEvent;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main stream function
// ---------------------------------------------------------------------------
export function streamCommandCode(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
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

    try {
      // ------------------------------------------------------------------
      // Resolve API key
      // ------------------------------------------------------------------
      const apiKey = options?.apiKey ?? "";
      if (!apiKey || apiKey.startsWith("$")) {
        throw new Error(
          "No CommandCode API key. Set COMMANDCODE_API_KEY env var or pass --api-key.",
        );
      }

      // ------------------------------------------------------------------
      // Build request body — frozen config, frozen system prompt,
      // frozen tools, dynamic messages only.
      // ------------------------------------------------------------------
      const body = {
        config: STATIC_CONFIG,
        memory: null,
        taste: null,
        skills: null,
        params: {
          model: model.id,
          messages: messagesToCC(context.messages),
          tools: context.tools ? freezeTools(context.tools) : [],
          system: STATIC_SYSTEM_PROMPT,
          max_tokens: options?.maxTokens ?? Math.min(model.maxTokens ?? 8192, 64000),
          temperature: 0.3,
          stream: true,
        },
        threadId: randomUUID(),
      };

      // ------------------------------------------------------------------
      // Make the HTTP request
      // ------------------------------------------------------------------
      const response = await fetch(COMMANDCODE_GENERATE_URL, {
        method: "POST",
        headers: buildHeaders(apiKey),
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`CommandCode API error ${response.status}: ${errBody.slice(0, 500)}`);
      }

      // ------------------------------------------------------------------
      // Read the SSE stream
      // ------------------------------------------------------------------
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let textBlock: { type: "text"; text: string } | undefined;
      let textIdx = -1;
      let thinkingIdx = -1;

      const endText = () => {
        if (textBlock) {
          stream.push({ type: "text_end", contentIndex: textIdx, content: textBlock.text, partial: output });
          textBlock = undefined;
          textIdx = -1;
        }
      };
      const endThinking = () => {
        if (thinkingIdx >= 0) {
          stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: (output.content[thinkingIdx] as any)?.thinking ?? "", partial: output });
          thinkingIdx = -1;
        }
      };

      stream.push({ type: "start", partial: output });

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
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
              // consume remaining buffer
              await reader.cancel().catch(() => {});
              break;
            }
          }
        }
      }

      endText();
      endThinking();

      // If we never got a finish event, set a default stop reason
      if (output.stopReason === "stop" && output.content.length === 0) {
        output.stopReason = "stop";
      }

      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();

      // ------------------------------------------------------------------
      // Event handler — returns true if finished
      // ------------------------------------------------------------------
      function handleEvent(evt: CCEvent): boolean {
        switch (evt.type) {
          case "text-delta": {
            endThinking();
            if (!textBlock) {
              textBlock = { type: "text", text: "" };
              output.content.push(textBlock);
              textIdx = output.content.length - 1;
              stream.push({ type: "text_start", contentIndex: textIdx, partial: output });
            }
            const delta = evt.text ?? "";
            textBlock.text += delta;
            stream.push({ type: "text_delta", contentIndex: textIdx, delta, partial: output });
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
              output.content.push({ type: "thinking", thinking: delta } as any);
              thinkingIdx = output.content.length - 1;
              stream.push({ type: "thinking_start", contentIndex: thinkingIdx, partial: output });
            } else {
              const tc = output.content[thinkingIdx] as any;
              if (tc) tc.thinking = (tc.thinking ?? "") + delta;
            }
            stream.push({ type: "thinking_delta", contentIndex: thinkingIdx, delta, partial: output });
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
              arguments: resolveArgs(evt),
            };
            output.content.push(toolCall);
            const idx = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
            return false;
          }

          case "tool-result": {
            return false;
          }

          case "finish": {
            const usage = evt.totalUsage;
            if (usage) {
              const details = (usage as any).inputTokenDetails;
              output.usage.input = (usage as any).inputTokens ?? 0;
              output.usage.output = (usage as any).outputTokens ?? 0;
              output.usage.cacheRead = details?.cacheReadTokens ?? 0;
              output.usage.cacheWrite = details?.cacheWriteTokens ?? 0;
              output.usage.totalTokens =
                output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
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
            output.stopReason = mapFinishReason(evt.finishReason);
            return true; // signal completion
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
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resolveArgs(evt: CCEvent & { type: "tool-call" }): Record<string, unknown> {
  const raw = evt.args ?? evt.input ?? evt.arguments ?? {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  return {};
}

function mapFinishReason(reason: unknown): "stop" | "length" | "toolUse" | "error" {
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
