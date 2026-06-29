/**
 * pi‑cleancache‑commandcode 🧊
 *
 * Proveedores:
 *   cleancache    — vía /alpha/generate (legacy, cache ~50%)
 *   cleancache-v1 — vía /provider/v1/chat/completions (OpenAI, cache ~90-100%)
 *
 * Uso:
 *   pi -e ./src/index.ts
 *   /login cleancache   (pega tu API key)
 *   /model cleancache-v1/deepseek/deepseek-v4-flash
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { login, refreshToken, getApiKey } from "./auth.js";
import { MODELS } from "./provider.js";
import { streamCommandCode } from "./stream.js";
import { streamCommandCodeV1 } from "./stream-v1.js";
import { COMMANDCODE_API_BASE, COMMANDCODE_PROVIDER_BASE } from "./utils.js";

export default async function (pi: ExtensionAPI) {
  // =========================================================================
  // 1.  PROVEEDOR LEGACY — /alpha/generate (cache ~50%)
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
  // 2.  PROVEEDOR V1 — /provider/v1/chat/completions (OpenAI, cache ~90-100%)
  // =========================================================================
  pi.registerProvider("cleancache-v1", {
    name: "CleanCache V1 (CommandCode Provider API)",
    baseUrl: COMMANDCODE_PROVIDER_BASE,
    apiKey: "$COMMANDCODE_API_KEY",
    api: "cleancache-v1" as any,
    authHeader: false,
    models: MODELS,
    streamSimple: streamCommandCodeV1,

    oauth: {
      name: "CleanCache V1 (CommandCode Provider API)",
      login,
      refreshToken,
      getApiKey,
    },
  });

  // =========================================================================
  // 3.  Notificación visual
  // =========================================================================
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `🧊 CleanCache — ${MODELS.length} modelo(s). Usa /model cleancache-v1/deepseek/deepseek-v4-flash (recomendado) o /model cleancache/... (legacy).`,
      "info",
    );
  });

  // =========================================================================
  // 4.  Comando /cleancache
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
          `ℹ️  CleanCache registrado. Usa /login cleancache y luego /model cleancache-v1/<modelo>`,
          "info",
        );
      }
    },
  });
}
