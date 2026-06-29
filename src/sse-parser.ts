/**
 * sse-parser.ts — Parse SSE lines from the CommandCode event stream.
 *
 * Each line of the stream is either:
 *   - a comment (starts with ":" or "event:")
 *   - a data line (starts with "data:")
 *   - a raw JSON line
 *   - "[DONE]" to signal end
 *
 * This module converts individual text lines into typed CCEvent objects.
 */

import type { CCEvent } from "./sse-types.js";

/**
 * Parse a single SSE line into a CCEvent, or undefined if the line
 * is a comment, empty, or malformed.
 */
export function parseEventLine(line: string): CCEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) {
    return undefined;
  }
  const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as CCEvent;
  } catch {
    return undefined;
  }
}
