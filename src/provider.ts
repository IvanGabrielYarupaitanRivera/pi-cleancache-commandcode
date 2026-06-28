/**
 * Provider configuration for the CleanCache bridge to CommandCode.
 *
 * Registers the `cleancache` provider with DeepSeek models served
 * through CommandCode's proxy, using a cache‑optimised streaming layer.
 *
 * Model IDs must match what CommandCode's provider API returns.
 * The default list covers the most common DeepSeek variants.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { COMMANDCODE_API_BASE, getModelCost, buildHeaders, STATIC_CONFIG } from "./utils.js";
import { streamCommandCode } from "./stream.js";

// ---------------------------------------------------------------------------
// Model catalogue — DeepSeek models via CommandCode
// ---------------------------------------------------------------------------
function deepseekModel(
  id: string,
  name: string,
  ctx: number,
  maxOut = 8192,
): ProviderModelConfig {
  const cost = getModelCost(id);
  return {
    id,
    name: `${name} (CleanCache)`,
    reasoning: false,
    input: ["text"] as const,
    cost,
    contextWindow: ctx,
    maxTokens: maxOut,
  };
}

export const MODELS: ProviderModelConfig[] = [
  deepseekModel("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, 65536),
  deepseekModel("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000, 65536),
  deepseekModel("deepseek-coder-v3", "DeepSeek Coder V3", 128_000),
  deepseekModel("deepseek-chat-v3", "DeepSeek Chat V3", 128_000),
  deepseekModel("deepseek-coder-v2", "DeepSeek Coder V2", 128_000),
  deepseekModel("deepseek-v3-0324", "DeepSeek V3.0 0324", 128_000),
];

// ---------------------------------------------------------------------------
// Build provider config
// ---------------------------------------------------------------------------
export function buildProviderConfig() {
  return {
    name: "CleanCache — Static Context (→ CommandCode)",
    baseUrl: COMMANDCODE_API_BASE,
    apiKey: "$COMMANDCODE_API_KEY",
    api: "cleancache-commandcode" as any,
    authHeader: false, // we handle auth in streamSimple
    models: MODELS,
    streamSimple: streamCommandCode,
  };
}
