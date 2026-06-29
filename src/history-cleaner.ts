/**
 * history-cleaner.ts — Trim thinking blocks from old assistant messages.
 *
 * DeepSeek caches using a Radix tree (prefix caching). Thinking blocks
 * from past assistant turns are "dead branches" — they were streamed
 * once and are never re-used, yet they account for ~80% of history size.
 *
 * This module removes `thinking` blocks from all assistant messages
 * except the most recent one, keeping the cache prefix short and identical.
 */

import type { Message } from "@earendil-works/pi-ai";

/**
 * Remove thinking blocks from all assistant messages except the last one.
 *
 * The last assistant message preserves its thinking so the model can
 * continue its chain-of-thought if needed. All older thinking is pruned.
 *
 * Returns a new array: the original messages are not mutated.
 */
export function cleanHistoryForCache(messages: readonly Message[]): Message[] {
  // Find the index of the LAST assistant message
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    // Only process assistant messages that are NOT the last one
    if (msg.role !== "assistant" || idx === lastAssistantIdx) return msg;
    if (!Array.isArray(msg.content)) return msg;

    const filteredContent = msg.content.filter(
      (block: any) => block.type !== "thinking",
    );

    // If nothing changed, return the original message reference
    if (filteredContent.length === msg.content.length) return msg;

    return { ...msg, content: filteredContent } as Message;
  });
}
