#!/usr/bin/env python3
"""Inserta la función splitHistory en stream.ts"""

with open('src/stream.ts', 'r', encoding='utf-8') as f:
    content = f.read()

splitHistoryFunc = '''
// ---------------------------------------------------------------------------
// PROMPT ACUMULATIVO:
// Separa el historial del último mensaje de usuario para incrustarlo
// en el system prompt y evitar la re-serialización de CommandCode.
// ---------------------------------------------------------------------------
function splitHistory(messages: readonly Message[]): {
  lastUserMsg: any;
  historyText: string;
} {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const historyMsgs = lastUserIdx > 0 ? messages.slice(0, lastUserIdx) : [];
  const historyText = historyToText(historyMsgs);
  if (lastUserIdx >= 0) {
    const lastMsg = messages[lastUserIdx];
    const txt =
      typeof lastMsg.content === "string"
        ? lastMsg.content
        : Array.isArray(lastMsg.content)
          ? lastMsg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text || "")
              .join("\\n")
          : "";
    return { lastUserMsg: { role: "user", content: txt }, historyText };
  }
  return { lastUserMsg: null, historyText };
}
'''

marker = '// ---------------------------------------------------------------------------\n// Main stream function\n// ---------------------------------------------------------------------------\nexport function streamCommandCode('

if marker in content:
    content = content.replace(marker, splitHistoryFunc + '\n' + marker)
    with open('src/stream.ts', 'w', encoding='utf-8') as f:
        f.write(content)
    print("OK: splitHistory insertado en stream.ts")
else:
    print("FAIL: marker no encontrado")
    # Debug
    idx = content.find('// Main stream function')
    if idx >= 0:
        print(content[idx:idx+100])
