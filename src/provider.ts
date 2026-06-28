/**
 * Model catalogue for CleanCache (CommandCode).
 *
 * Los modelos están hardcodeados para mantener el arranque rápido.
 * Si quieres la lista dinámica como pi-commandcode-provider,
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getModelCost } from "./utils.js";

function model(
  id: string,
  name: string,
  ctx: number,
  maxOut = 8192,
  reasoning = false,
): ProviderModelConfig {
  const cost = getModelCost(id);
  return {
    id,
    name: `${name} (CleanCache)`,
    reasoning,
    thinkingLevelMap: reasoning
      ? {
          off: null,
          minimal: "512",
          low: "1024",
          medium: "2048",
          high: "4096",
          xhigh: "8192",
        }
      : undefined,
    input: ["text"] as const,
    cost,
    contextWindow: ctx,
    maxTokens: maxOut,
  };
}

export const MODELS: ProviderModelConfig[] = [
  // DeepSeek via CommandCode — reasoning supported
  model("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, 65536, true),
  model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000, 65536, true),
  // Otros modelos (sin reasoning)
  model("deepseek-coder-v3", "DeepSeek Coder V3", 128_000),
  model("deepseek-chat-v3", "DeepSeek Chat V3", 128_000),
  model("deepseek-coder-v2", "DeepSeek Coder V2", 128_000),
  model("deepseek-v3-0324", "DeepSeek V3.0 0324", 128_000),
];
