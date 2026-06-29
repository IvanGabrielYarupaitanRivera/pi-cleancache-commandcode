/**
 * stream‑v1.ts — CleanCache V1
 * =============================
 * Stream wrapper para el endpoint OpenAI‑compatible de CommandCode:
 *   POST /provider/v1/chat/completions
 *
 * Formato estándar OpenAI → sin re‑serialización de CommandCode →
 * prefix caching de DeepSeek al 90‑100%.
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  STATIC_SYSTEM_PROMPT,
  freezeTools,
  getModelCost,
  sanitise,
  COMMANDCODE_CHAT_URL,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Convertir mensajes de Pi a formato OpenAI
// ---------------------------------------------------------------------------
function toOpenAIMessages(messages: readonly Message[]) {
  const out: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((c) => c.type === "text")
                .map((c) => ({ type: "text", text: sanitise((c as any).text) }))
            : msg.content;
      out.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const parts: any[] = [];
      let toolCalls: any[] | undefined;
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (block.type === "text" && (block as any).text) {
          parts.push({ type: "text", text: sanitise((block as any).text) });
        } else if (block.type === "toolCall") {
          toolCalls = toolCalls ?? [];
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments:
                typeof block.arguments === "string"
                  ? block.arguments
                  : JSON.stringify(block.arguments),
            },
          });
        }
      }
      const entry: any = { role: "assistant" };
      if (parts.length > 0) {
        entry.content =
          parts.length === 1 && parts[0].type === "text"
            ? parts[0].text
            : parts;
      } else {
        entry.content = "";
      }
      if (toolCalls) entry.tool_calls = toolCalls;
      out.push(entry);
    } else if (msg.role === "toolResult") {
      const tr = msg as ToolResultMessage;
      out.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content:
          typeof tr.content === "string"
            ? tr.content
            : Array.isArray(tr.content)
              ? tr.content
                  .filter((c) => c.type === "text")
                  .map((c) => (c as any).text)
                  .join("\n")
              : "",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSE Parser para OpenAI streaming
// ---------------------------------------------------------------------------
function parseOpenAIEvent(line: string): any | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "data: [DONE]") return undefined;
  if (!trimmed.startsWith("data: ")) return undefined;
  const json = trimmed.slice(6);
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Stream principal
// ---------------------------------------------------------------------------
export function streamCommandCodeV1(
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
      const apiKey = options?.apiKey ?? "";
      if (!apiKey || apiKey.startsWith("$")) {
        throw new Error(
          "No CommandCode API key. Set COMMANDCODE_API_KEY env var or pass --api-key.",
        );
      }

      // ── Construir body en formato OpenAI ──
      const messages = toOpenAIMessages(context.messages);

      const body: Record<string, any> = {
        model: model.id,
        messages: [
          { role: "system", content: STATIC_SYSTEM_PROMPT },
          ...messages,
        ],
        temperature: 0.3,
        stream: true,
        stream_options: { include_usage: true },
      };

      // Tools (formato OpenAI)
      if (context.tools && context.tools.length > 0) {
        body.tools = freezeTools(context.tools).map((t: any) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));
      }

      // Reasoning / thinking
      if (options?.reasoning && model.reasoning) {
        const budget = parseInt(
          model.thinkingLevelMap?.[options.reasoning] ?? "2048",
          10,
        );
        body.thinking = { type: "enabled", budget_tokens: budget };
      }

      // ── Fetch ──
      const response = await fetch(COMMANDCODE_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(
          `CommandCode Provider API error ${response.status}: ${errBody.slice(0, 500)}`,
        );
      }

      // ── Leer SSE ──
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let textContent = "";
      let textIdx = -1;
      let reasoningContent = "";
      let reasoningIdx = -1;
      let currentToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
      let finishReason: string | undefined;
      let finalUsage: any;

      stream.push({ type: "start", partial: output });

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const evt = parseOpenAIEvent(line);
          if (!evt) continue;

          // Si no hay choices pero hay usage (último chunk)
          if (evt.usage) {
            finalUsage = evt.usage;
          }

          const choice = evt.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta ?? {};
          finishReason = choice.finish_reason ?? finishReason;

          // Text content
          if (delta.content) {
            if (textIdx === -1) {
              textContent = "";
              textIdx = output.content.length;
              output.content.push({ type: "text", text: "" });
              stream.push({ type: "text_start", contentIndex: textIdx, partial: output });
            }
            textContent += delta.content;
            (output.content[textIdx] as any).text = textContent;
            stream.push({ type: "text_delta", contentIndex: textIdx, delta: delta.content, partial: output });
          }

          // Reasoning content (DeepSeek-specific)
          if ((delta as any).reasoning_content) {
            const rc = (delta as any).reasoning_content;
            if (reasoningIdx === -1) {
              reasoningContent = "";
              reasoningIdx = output.content.length;
              output.content.push({ type: "thinking", thinking: "" } as any);
              stream.push({ type: "thinking_start", contentIndex: reasoningIdx, partial: output });
            }
            reasoningContent += rc;
            (output.content[reasoningIdx] as any).thinking = reasoningContent;
            stream.push({ type: "thinking_delta", contentIndex: reasoningIdx, delta: rc, partial: output });
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!currentToolCalls.has(idx)) {
                currentToolCalls.set(idx, {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  args: tc.function?.arguments ?? "",
                });
              } else {
                const existing = currentToolCalls.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
              }
            }
          }

          // Si es el último chunk (finish_reason presente)
          if (choice.finish_reason) {
            break;
          }
        }
        if (finishReason) break;
      }

      // ── Finalizar texto ──
      if (textIdx >= 0) {
        stream.push({ type: "text_end", contentIndex: textIdx, content: textContent, partial: output });
      }

      // ── Finalizar razonamiento ──
      if (reasoningIdx >= 0) {
        stream.push({ type: "thinking_end", contentIndex: reasoningIdx, content: reasoningContent, partial: output });
      }

      // ── Procesar tool calls ──
      for (const [, tc] of currentToolCalls) {
        if (tc.name) {
          const toolCall = {
            type: "toolCall" as const,
            id: tc.id,
            name: tc.name,
            arguments: parseArgs(tc.args),
          };
          output.content.push(toolCall);
          const idx = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
        }
      }

      // ── Procesar usage ──
      if (finalUsage) {
        output.usage.input = finalUsage.prompt_tokens ?? 0;
        output.usage.output = finalUsage.completion_tokens ?? 0;
        output.usage.cacheRead = finalUsage.prompt_cache_hit_tokens ?? 0;
        output.usage.cacheWrite = finalUsage.prompt_cache_miss_tokens ?? 0;

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

      // ── Stop reason ──
      output.stopReason = mapFinishReason(finishReason);

      stream.push({ type: "done", reason: output.stopReason as any, message: output });
      stream.end();
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
function parseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { return {}; }
}

function mapFinishReason(reason: string | undefined): "stop" | "length" | "toolUse" | "error" {
  if (reason === "tool_calls") return "toolUse";
  if (reason === "length" || reason === "max_tokens") return "length";
  return "stop";
}
