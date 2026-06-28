/**
 * Model catalogue for CleanCache (CommandCode).
 *
 * Los modelos están hardcodeados para mantener el arranque rápido.
 * Si quieres la lista dinámica como pi-commandcode-provider,
 */ import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getModelCost } from "./utils.js";

function model(
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
  // DeepSeek via CommandCode
  model("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, 65536),
  model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000, 65536),
  model("deepseek-coder-v3", "DeepSeek Coder V3", 128_000),
  model("deepseek-chat-v3", "DeepSeek Chat V3", 128_000),
  model("deepseek-coder-v2", "DeepSeek Coder V2", 128_000),
  model("deepseek-v3-0324", "DeepSeek V3.0 0324", 128_000),
];
