#!/usr/bin/env python3
"""Patches stream.ts with Prompt Acumulativo + Padding 256 + Flags ocultos"""

import re

with open('src/stream.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# =========================================================
# 1. HEADER - Update the file description
# =========================================================
old_header = """/**
 * Cache‑optimised stream for the CommandCode API (non‑standard protocol).
 *
 * The CommandCode API at POST /alpha/generate uses a custom JSON body and
 * SSE‑like event stream.  This implementation:
 *
 *  1.  FREEZES the config object so it's byte‑identical every request.
 *  2.  FREEZES the system prompt (STATIC_SYSTEM_PROMPT).
 *  3.  FREEZES the tool definitions (sorted, stripped).
 *  4.  Disables the Taste‑1 tracking loop (x-taste-learning: false).
 *  5.  Uses a static project slug.
 *
 * Result: every request shares a byte‑identical prefix → DeepSeek
 * prefix caching hits at 87‑99% instead of ~30%.
 */"""

new_header = """/**
 * Cache‑optimised stream for the CommandCode API (non‑standard protocol).
 *
 * The CommandCode API at POST /alpha/generate uses a custom JSON body and
 * SSE‑like event stream.  This implementation:
 *
 *  1.  FREEZES the config object so it's byte‑identical every request.
 *  2.  FREEZES the system prompt (STATIC_SYSTEM_PROMPT).
 *  3.  FREEZES the tool definitions (sorted, stripped).
 *  4.  Disables the Taste‑1 tracking loop (x-taste-learning: false).
 *  5.  Uses a static project slug.
 *  6.  PROMPT ACUMULATIVO: historial consolidado DENTRO del system prompt.
 *  7.  PADDING 256: alineación a bloques de 256 tokens (DeepSeek V4).
 *  8.  FLAGS OCULTOS: cache_prompt + disable_backend_formatting.
 *
 * Result: every request shares a byte‑identical prefix → DeepSeek
 * prefix caching hits at 87‑99% instead of ~30%.
 */"""

content = content.replace(old_header, new_header)

# =========================================================
# 2. Add import for promptTo256Padding
# =========================================================
content = content.replace(
    'import {\n  COMMANDCODE_GENERATE_URL,\n  STATIC_CONFIG,\n  STATIC_SYSTEM_PROMPT,\n  buildHeaders,\n  freezeTools,\n  getModelCost,\n  sanitise,\n} from "./utils.js";',
    'import {\n  COMMANDCODE_GENERATE_URL,\n  STATIC_CONFIG,\n  STATIC_SYSTEM_PROMPT,\n  buildHeaders,\n  freezeTools,\n  getModelCost,\n  sanitise,\n  promptTo256Padding,\n  historyToText,\n} from "./utils.js";'
)

# =========================================================
# 3. Replace messagesToCC - we need a new function to extract
#    the last user message and serialize the rest as history
# =========================================================
# After the messagesToCC function, add a new function for prompt acumulativo

old_messages_end = """function extractText(msg: ToolResultMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------"""

# Add new function between extractText and parseEventLine
new_messages_end = """function extractText(msg: ToolResultMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// PROMPT ACUMULATIVO:
// Convierte todo el historial (excepto el último mensaje de usuario) a texto
// plano incrustado en el system prompt, para que CommandCode NO pueda
// re-serializar cada mensaje individualmente.
// El array messages solo lleva el ÚLTIMO mensaje del usuario.
// ---------------------------------------------------------------------------
function splitHistory(messages: readonly Message[]): {
  lastUserMsg: unknown;
  historyText: string;
} {
  // Encontrar el último mensaje de usuario
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  // Historial: todo ANTES del último mensaje de usuario
  const historyMsgs = lastUserIdx > 0 ? messages.slice(0, lastUserIdx) : [];
  const historyText = historyToText(historyMsgs);

  // Último mensaje de usuario
  if (lastUserIdx >= 0) {
    const lastMsg = messages[lastUserIdx];
    const content =
      typeof lastMsg.content === "string"
        ? lastMsg.content
        : Array.isArray(lastMsg.content)
          ? lastMsg.content
              .filter((c) => c.type === "text")
              .map((c) => sanitise((c as any).text))
              .join("\\n")
          : "";
    return {
      lastUserMsg: { role: "user", content },
      historyText,
    };
  }

  return {
    lastUserMsg: null,
    historyText,
  };
}

// ---------------------------------------------------------------------------"""

content = content.replace(old_messages_end, new_messages_end)

# =========================================================
# 4. Replace the body construction with the new optimized version
# =========================================================
old_body = """      // ------------------------------------------------------------------
      // Build request body — frozen config, frozen system prompt,
      // frozen tools, dynamic messages only.
      // ------------------------------------------------------------------
      const body = {
        config: STATIC_CONFIG,
        memory: null,
        taste: null,
        skills: null,
        params: {
          model: model.id,
          messages: messagesToCC(context.messages),
          tools: context.tools ? freezeTools(context.tools) : [],
          system: STATIC_SYSTEM_PROMPT,
          max_tokens: 8192, // frozen — never varies between requests
          temperature: 0.3,
          stream: true,
          ...(options?.reasoning && model.reasoning
            ? {
                thinking: {
                  type: 'enabled',
                  budget_tokens: parseInt(
                    model.thinkingLevelMap?.[options.reasoning] ?? '2048',
                    10
                  ),
                },
              }
            : {}),
        },
        threadId: SESSION_THREAD_ID,
      };"""

new_body = """      // ------------------------------------------------------------------
      // PROMPT ACUMULATIVO:
      // 1. Separa el historial del último mensaje de usuario
      // 2. Convierte el historial a texto plano
      // 3. Lo inyecta DENTRO del system prompt (para evitar re-serialización)
      // 4. Aplica padding a bloques de 256 tokens (DeepSeek V4)
      // 5. Envía solo el último mensaje en params.messages
      // 6. Añade flags ocultos para forzar caché
      // ------------------------------------------------------------------
      // Build base system prompt with history embedded
      const { lastUserMsg, historyText } = splitHistory(context.messages);

      // System prompt = STATIC + history + padding
      const accumulatedSystem = historyText
        ? STATIC_SYSTEM_PROMPT + "\\n\\n====== HISTORIAL ======\\n" + historyText
        : STATIC_SYSTEM_PROMPT;

      const paddedSystem = promptTo256Padding(accumulatedSystem);

      // Messages array: SOLO el último mensaje del usuario
      const finalMessages = lastUserMsg ? [lastUserMsg] : [];

      const params: Record<string, any> = {
        model: model.id,
        messages: finalMessages,
        tools: context.tools ? freezeTools(context.tools) : [],
        system: paddedSystem,
        max_tokens: 8192,
        temperature: 0.3,
        stream: true,
      };

      // Reasoning / thinking
      if (options?.reasoning && model.reasoning) {
        params.thinking = {
          type: 'enabled',
          budget_tokens: parseInt(
            model.thinkingLevelMap?.[options.reasoning] ?? '2048',
            10
          ),
        };
      }

      const body = {
        config: STATIC_CONFIG,
        memory: null,
        taste: null,
        skills: null,
        // ── FLAGS OCULTOS para forzar caché ──
        cache_prompt: true,
        disable_backend_formatting: true,
        params: params,
        threadId: SESSION_THREAD_ID,
      };"""

content = content.replace(old_body, new_body)

with open('src/stream.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("OK: stream.ts parcheado con Prompt Acumulativo + Padding 256 + Flags ocultos")
