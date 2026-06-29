/**
 * sse-types.ts — Event types for the CommandCode SSE stream.
 *
 * The CommandCode API at POST /alpha/generate returns an SSE-like
 * event stream where each line is a JSON object with a `type` field.
 *
 * This module defines the TypeScript discriminated union for those
 * events so the parser and handler can be type-safe.
 */

export type CCEvent =
  | { type: "text-delta"; text?: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text?: string }
  | { type: "reasoning-end" }
  | {
      type: "tool-call";
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      input?: unknown;
      arguments?: unknown;
    }
  | { type: "tool-result" }
  | {
      type: "finish";
      finishReason?: string;
      totalUsage?: Record<string, unknown>;
    }
  | { type: "error"; error?: unknown };
