/**
 * Utility helpers for the CleanCache CommandCode custom provider.
 *
 * The central goal: every request sends a **byte-identical prefix**
 * (config object + system prompt + tool definitions) so that
 * CommandCode's DeepSeek backend hits prefix cache at 87‑99%
 * instead of ~30%.
 */

import type { Tool } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Static system prompt — exact same bytes every request.
// ---------------------------------------------------------------------------
export const STATIC_SYSTEM_PROMPT = `You are an expert software engineering assistant running inside the Pi coding agent harness.

You have access to these tools:
  - read:   Read file contents (supports text and images)
  - write:  Create or overwrite files (creates parent directories)
  - edit:   Make precise file edits with exact text replacement
  - bash:   Execute bash commands (use for ls, grep, find, compilation, tests, etc.)
  - grep:   Search file contents with regular expressions
  - find:   Find files matching patterns
  - ls:     List directory contents

Guidelines:
  - Always show file paths clearly when working with files.
  - Use bash for file operations like ls, grep, find.
  - Prefer edit for precise changes over full rewrites.
  - Be concise in your responses.
  - Complete the task fully before signalling done.

No telemetry. No system-architecture logs. No dynamic metadata.
Strictly static context for maximum prefix-cache reuse.`;

// ---------------------------------------------------------------------------
// Frozen tool definitions — sorted by name, stripped of ephemeral fields.
// ---------------------------------------------------------------------------
export function freezeTools(tools: Tool[]): any[] {
  return tools
    .map((t) => ({
      type: "function",
      name: t.name ?? "",
      description: t.description ?? "",
      input_schema: (t.parameters as any) ?? {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// CommandCode API constants
// ---------------------------------------------------------------------------
export const COMMANDCODE_API_BASE =
  process.env["COMMANDCODE_API_BASE"] ??
  process.env["COMMANDCODE_BASE_URL"] ??
  process.env["COMMAND_CODE_BASE_URL"] ??
  "https://api.commandcode.ai";

export const COMMANDCODE_GENERATE_URL = `${COMMANDCODE_API_BASE}/alpha/generate`;

// ── Provider API v1 (OpenAI-compatible, mejor caché) ──
export const COMMANDCODE_PROVIDER_BASE =
  process.env["COMMANDCODE_PROVIDER_BASE_URL"] ??
  "https://api.commandcode.ai/provider/v1";

export const COMMANDCODE_CHAT_URL = `${COMMANDCODE_PROVIDER_BASE}/chat/completions`;

export const COMMANDCODE_CLI_VERSION = "0.40.11";

// ---------------------------------------------------------------------------
// FROZEN config object — replaces the dynamic config that the standard
// provider sends (workingDir, date, environment info, git status, etc.).
// Because those fields change constantly, they destroy prefix caching.
// ---------------------------------------------------------------------------
export const STATIC_CONFIG = {
  workingDir: "/project",
  date: "2026-01-01",           // frozen date — never changes
  environment: "static-clean-cache",
  structure: [],
  isGitRepo: false,
  currentBranch: "",
  mainBranch: "",
  gitStatus: "",
  recentCommits: [],
};

// ---------------------------------------------------------------------------
// Frozen request headers (no dynamic project slug, no taste-learning)
// ---------------------------------------------------------------------------
export function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "x-command-code-version": COMMANDCODE_CLI_VERSION,
    "x-cli-environment": "production",
    "x-project-slug": "cleancache-static",  // static — never changes
    "x-taste-learning": "false",            // ← DISABLE the tracking loop
    "x-co-flag": "false",
    "x-bypass-transform": "true",   // ← pide proxy transparente
    "x-raw-payload": "true",        // ← pide payload sin modificar
  };
}

// ---------------------------------------------------------------------------
// Cost table (matches the existing pi-commandcode-provider pricing)
// ---------------------------------------------------------------------------
export const MODEL_COST: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "deepseek/deepseek-v4-pro": { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
  "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
};

export function getModelCost(modelId: string) {
  return MODEL_COST[modelId] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// ---------------------------------------------------------------------------
// Utility: sanitise surrogate pairs
// ---------------------------------------------------------------------------
export function sanitise(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}
