/**
 * pi‑cleancache‑commandcode 🧊
 *
 * Proveedor único: cleancache — vía /alpha/generate
 * Optimizado para el plan Go de $1/mes con prefix caching 90-100%.
 *
 * Uso:
 *   /login cleancache   (pega tu API key)
 *   /model cleancache/deepseek/deepseek-v4-flash
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { login, refreshToken, getApiKey } from "./auth.js";
import { MODELS } from "./provider.js";
import { streamCommandCode } from "./stream.js";
import { COMMANDCODE_API_BASE } from "./utils.js";

export default async function (pi: ExtensionAPI) {
  // =========================================================================
  // PROVEEDOR — /alpha/generate con prefix caching optimizado
  // =========================================================================
  pi.registerProvider("cleancache", {
    name: "CleanCache (CommandCode /alpha/generate)",
    baseUrl: COMMANDCODE_API_BASE,
    apiKey: "$COMMANDCODE_API_KEY",
    api: "cleancache-commandcode" as any,
    authHeader: false,
    models: MODELS,
    streamSimple: streamCommandCode,

    oauth: {
      name: "CleanCache (CommandCode)",
      login,
      refreshToken,
      getApiKey,
    },
  });

  // =========================================================================
  // Notificación visual
  // =========================================================================
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `🧊 CleanCache — ${MODELS.length} modelo(s). Usa /model cleancache/deepseek/deepseek-v4-flash`,
      "info",
    );
  });

  // =========================================================================
  // Comando /cleancache
  // =========================================================================
  pi.registerCommand("cleancache", {
    description: "Show CleanCache provider status",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (model?.provider?.startsWith("cleancache")) {
        ctx.ui.notify(
          `🧊 CleanCache active: ${model.provider}/${model.id}`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `ℹ️  CleanCache registrado. Usa /login cleancache y luego /model cleancache/<modelo>`,
          "info",
        );
      }
    },
  });
}
