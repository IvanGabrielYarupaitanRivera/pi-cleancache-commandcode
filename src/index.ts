/**
 * pi‑cleancache‑commandcode 🧊
 *
 * Registra el provider `cleancache` con:
 *   - `/login cleancache` para pegar tu API key de CommandCode
 *   - Cache‑optimised streaming (contexto 100% estático)
 *
 * Uso:
 *   pi -e ./src/index.ts
 *   /login cleancache   (pega tu key user_...)
 *   /model cleancache/deepseek/deepseek-v4-flash
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { login, refreshToken, getApiKey } from "./auth.js";
import { MODELS } from "./provider.js";
import { streamCommandCode } from "./stream.js";
import { COMMANDCODE_API_BASE } from "./utils.js";

export default async function (pi: ExtensionAPI) {
  // =========================================================================
  // 1.  Registrar el provider con OAuth + stream custom
  // =========================================================================
  pi.registerProvider("cleancache", {
    name: "CleanCache (CommandCode Static Context)",
    baseUrl: COMMANDCODE_API_BASE,
    apiKey: "$COMMANDCODE_API_KEY",
    api: "cleancache-commandcode" as any,
    authHeader: false, // nosotros manejamos auth en streamSimple
    models: MODELS,
    streamSimple: streamCommandCode,

    // ── OAuth: permite `/login cleancache` ──
    oauth: {
      name: "CleanCache (CommandCode)",
      login,
      refreshToken,
      getApiKey,
    },
  });

  // =========================================================================
  // 2.  Notificación visual
  // =========================================================================
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `🧊 CleanCache — ${MODELS.length} modelo(s). Usa /login cleancache para autenticar y /model para seleccionar.`,
      "info",
    );
  });

  // =========================================================================
  // 3.  Comando /cleancache
  // =========================================================================
  pi.registerCommand("cleancache", {
    description: "Show CleanCache provider status",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      if (model?.provider === "cleancache") {
        ctx.ui.notify(
          `🧊 CleanCache active: ${model.id} @ ${COMMANDCODE_API_BASE}`,
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
