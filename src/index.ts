/**
 * pi‑cleancache‑commandcode 🧊
 *
 * Registra el provider `cleancache` — un bridge cache‑optimizado
 * hacia CommandCode API que congela TODO el contexto dinámico para
 * maximizar el Prefix Caching de DeepSeek.
 *
 * Uso:
 *   export COMMANDCODE_API_KEY=user_...
 *   pi -e ./src/index.ts
 *   /model cleancache/deepseek/deepseek-v4-flash
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildProviderConfig } from "./provider.js";
import { STATIC_SYSTEM_PROMPT, STATIC_CONFIG } from "./utils.js";

export default function (pi: ExtensionAPI) {
  const config = buildProviderConfig();

  // =========================================================================
  // 1.  Register the provider
  // =========================================================================
  pi.registerProvider("cleancache", {
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    api: config.api,
    models: config.models,
    streamSimple: config.streamSimple,
    authHeader: false,
  });

  // =========================================================================
  // 2.  Log on session start
  // =========================================================================
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      `🧊 CleanCache ready — ${config.models.length} model(s) via cleancache`,
      "info",
    );
  });

  // =========================================================================
  // 3.  Guard: normalise payload before sending (for any non-custom path)
  // =========================================================================
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "cleancache") return;
    // no-op: our streamSimple handles freezing
    return;
  });

  // =========================================================================
  // 4.  Commands
  // =========================================================================
  pi.registerCommand("cleancache", {
    description: "Show CleanCache provider status",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (model?.provider === "cleancache") {
        ctx.ui.notify(
          `🧊 CleanCache active: ${model.id} @ ${config.baseUrl}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `ℹ️  Use /model cleancache/<model> to activate CleanCache`,
          "info",
        );
      }
    },
  });
}
