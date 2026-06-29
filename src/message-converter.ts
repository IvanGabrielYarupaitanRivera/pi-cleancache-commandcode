/**
 * message-converter.ts — Convert Pi message format to CommandCode format.
 *
 * The Pi agent represents messages with roles "user" / "assistant" / "toolResult"
 * and content that can be a string or an array of content blocks.
 *
 * CommandCode expects:
 *   - role "user" with string or array of content blocks
 *   - role "assistant" with array of blocks (text, reasoning, tool-call)
 *   - role "tool" with an array containing a single tool-result block
 *
 * ═══ 256-TOKEN BOUNDARY PADDING ═══
 * DeepSeek V4's MLA architecture caches prefix blocks in strict 256-token
 * boundaries. If a message's token count is not a multiple of 256, the Radix
 * tree alignment shifts across turns, causing a cache miss.
 *
 * ALL messages (user, assistant, tool) receive alignMessageForCache() on
 * their text/reasoning content. This appends a deterministic comment block
 * that pads the message to the next 256-token boundary. Because the padding
 * is a deterministic function of the content alone, every reconstruction of
 * the same conversational state produces byte-identical messages.
 */

import { type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { alignMessageForCache, sanitise } from "./utils.js";

/**
 * Convert a flat list of Pi messages into the format expected by
 * the CommandCode /alpha/generate endpoint.
 */
export function messagesToCC(messages: readonly Message[]): unknown[] {
  const out: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      out.push(convertUserMessage(msg));
    } else if (msg.role === "assistant") {
      const parts = convertAssistantMessage(msg);
      if (parts.length > 0) out.push({ role: "assistant", content: parts });
    } else if (msg.role === "toolResult") {
      out.push(convertToolResultMessage(msg as ToolResultMessage));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Per-role converters
// ---------------------------------------------------------------------------

function convertUserMessage(msg: Message): unknown {
  const content =
    typeof msg.content === "string"
      ? alignMessageForCache(msg.content)
      : Array.isArray(msg.content)
        ? msg.content.map((c) =>
            c.type === "text"
              ? { type: "text", text: alignMessageForCache(sanitise(c.text)) }
              : c,
          )
        : msg.content;

  return { role: "user", content };
}

function convertAssistantMessage(msg: Message): unknown[] {
  const parts: unknown[] = [];
  const content = Array.isArray(msg.content) ? msg.content : [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      // Pad each text block individually so its token count locks into a 256-boundary.
      // This ensures the byte-signature is identical every time this message is
      // reconstructed in future turns (deterministic padding based on content).
      parts.push({ type: "text", text: alignMessageForCache(sanitise(block.text)) });
    } else if (block.type === "thinking" && (block as any).thinking) {
      parts.push({
        type: "reasoning",
        text: alignMessageForCache(sanitise((block as any).thinking)),
      });
    } else if (block.type === "toolCall") {
      parts.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        input: block.arguments,
      });
    }
  }

  return parts;
}

function convertToolResultMessage(tr: ToolResultMessage): unknown {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: tr.isError
          ? { type: "error-text", value: alignMessageForCache(extractText(tr)) }
          : { type: "text", value: alignMessageForCache(extractText(tr)) },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
