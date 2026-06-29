/**
 * history-cleaner.ts — Strip thinking blocks from all past assistant messages.
 *
 * ═══ RADIX CACHE RATIONALE ═══
 * DeepSeek's MLA architecture uses a Radix (prefix tree) cache keyed on
 * token sequences. Thinking blocks (<think>...</think>) are contextually
 * unstable for long-term prefix tree storage because:
 *   - They are streamed once and never re-consumed
 *   - Their token content can vary even for semantically identical thoughts
 *   - They inflate the prefix tree, creating divergent branches
 *
 * For ALL past assistant role objects, strip the inner thinking content
 * completely before rebuilding the history array. This keeps the prefix
 * short, stable, and identical across turns.
 *
 * The current assistant message being streamed is NOT in the history array
 * at the time of the next request — only past turns are. So we strip
 * thinking unconditionally from every assistant message in history.
 */

import type { Message } from "@earendil-works/pi-ai";

/**
 * Remove thinking blocks from ALL assistant messages in the history.
 *
 * Every assistant message gets its thinking blocks stripped. This ensures
 * the Radix prefix tree stays clean: thinking tokens from past turns are
 * dead branches that would otherwise rot the cache.
 *
 * Returns a new array; the original messages are not mutated.
 */
export function cleanHistoryForCache(messages: readonly Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    if (!Array.isArray(msg.content)) return msg;

    const filteredContent = msg.content.filter(
      (block: any) => block.type !== "thinking",
    );

    // If nothing changed, return the original reference
    if (filteredContent.length === msg.content.length) return msg;

    return { ...msg, content: filteredContent } as Message;
  });
}
