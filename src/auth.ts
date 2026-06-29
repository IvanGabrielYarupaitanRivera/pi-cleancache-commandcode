/**
 * OAuth / login flow for CleanCache (CommandCode API).
 *
 * Implementa el mismo patrón que pi-commandcode-provider y
 * pi-openmodel-provider para que Pi gestione la autenticación.
 *
 * El usuario puede:
 *   1. `/login cleancache` → pegar API key manualmente
 *   2. Setear COMMANDCODE_API_KEY como env var
 *   3. Poner la key en ~/.pi/agent/auth.json
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Tipos inline — compatibles con lo que Pi espera para oauth
interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

interface OAuthLoginCallbacks {
  onAuth(params: { url: string }): void;
  onPrompt(params: { message: string }): Promise<string>;
}

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Login: pide la API key al usuario
// ---------------------------------------------------------------------------
export async function login(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  // Intentar abrir browser (opcional — el usuario puede pegar la key)
  callbacks.onAuth({
    url: "https://commandcode.ai/studio",
  });

  const apiKey = (
    await callbacks.onPrompt({
      message:
        "Paste your CommandCode API key (user_...):",
    })
  ).trim();

  if (!apiKey) throw new Error("No API key provided");

  // Conexión exitosa 🧊
  return {
    refresh: apiKey,
    access: apiKey,
    expires: Date.now() + TEN_YEARS_MS,
  };
}

// ---------------------------------------------------------------------------
// Refresh: no-op (las API keys de CommandCode no expiran)
// ---------------------------------------------------------------------------
export async function refreshToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  return {
    refresh: credentials.refresh,
    access: credentials.access,
    expires: Date.now() + TEN_YEARS_MS,
  };
}

// ---------------------------------------------------------------------------
// getApiKey: extrae la key de las credenciales
// ---------------------------------------------------------------------------
export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

// ---------------------------------------------------------------------------
// hasApiKey: detecta si hay una key configurada
// ---------------------------------------------------------------------------
export async function hasApiKey(): Promise<boolean> {
  if (process.env["COMMANDCODE_API_KEY"]) return true;

  const home = homedir();
  const authPaths = [
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".commandcode", "auth.json"),
  ];

  for (const p of authPaths) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const provider =
        data["cleancache"] ?? data["commandcode"] ?? data["command-code"];
      if (provider?.access || provider?.key) return true;
      if (data.apiKey) return true;
    } catch {
      // ignore malformed files
    }
  }
  return false;
}
