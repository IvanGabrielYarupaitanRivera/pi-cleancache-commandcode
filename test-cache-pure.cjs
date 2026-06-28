const { execSync } = require("child_process");
const { resolve } = require("path");
const EXT = resolve(process.cwd(), "src/index.ts");
const MODEL = "cleancache/deepseek/deepseek-v4-flash";
const PROMPT = "What is 2+2? Just answer the number.";
const RUNS = 8;

function extractUsage(raw) {
  for (const rawLine of raw.split("\n").filter(Boolean)) {
    // Strip terminal OSC escape sequences (e.g. ESC ] 777 ; notify ; ... BEL) that Pi may inject
    const line = rawLine.replace(/\u001b\][0-9]+;.*?\u0007/g, "");
    try {
      const evt = JSON.parse(line);
      if (evt.type === "message_end" && evt.message?.role === "assistant") {
        const u = evt.message.usage;
        if (u && (u.input || u.cacheRead)) return { input: u.input??0, cacheRead: u.cacheRead??0, cacheWrite: u.cacheWrite??0, output: u.output??0 };
      }
    } catch (_) {}
  }
  return null;
}

function ch(u) {
  if (!u) return 0;
  const eff = u.input + u.cacheWrite;
  return eff > 0 ? (u.cacheRead / eff) * 100 : 0;
}

console.log("=".repeat(70));
console.log("🧊 CleanCache — Pure Prefix Cache Test");
console.log("=".repeat(70));
console.log(`Model:  ${MODEL}`);
console.log(`Prompt: "${PROMPT}"`);
console.log(`Runs:   ${RUNS} (1 warm-up + ${RUNS-1} measured)`);
console.log("");

const results = [];

for (let i = 0; i < RUNS; i++) {
  process.stdout.write(`  [${i+1}/${RUNS}] ... `);
  const cmd = `pi --mode json -e "${EXT}" --model "${MODEL}" -p "${PROMPT}" 2>&1`;
  try {
    const raw = execSync(cmd, { cwd: process.cwd(), encoding: "utf-8", timeout: 60_000, maxBuffer: 10*1024*1024 });
    const u = extractUsage(raw);
    if (u) {
      results.push(u);
      console.log(`↑${String(u.input).padStart(5)} R${String(u.cacheRead).padStart(5)} CH${ch(u).toFixed(1).padStart(5)}%`);
    } else {
      // Print raw for debugging
      console.log(`❌ no usage — ${raw.slice(0,100)}`);
    }
  } catch (e) {
    console.log(`❌ ${e.message.slice(0,60)}`);
  }
}

console.log("");
if (results.length >= 2) {
  const measured = results.slice(1);
  const rates = measured.map(ch);
  const avg = rates.reduce((a,b) => a+b, 0) / rates.length;
  console.log(`📊 Cache Hit Rate PROMEDIO (post warm-up): ${avg.toFixed(1)}%`);
  results.forEach((u, i) => console.log(`   ${i===0?'Warm-up':`Req #${i+1}`}: ↑${u.input} R${u.cacheRead} CH${ch(u).toFixed(1)}%`));
  if (avg >= 85) console.log("\n🟢 CleanCache funciona — caché estable ≥85%!");
  else if (avg >= 60) console.log("\n🟡 CleanCache ayuda — aún hay margen de mejora");
  else console.log("\n🔴 Bajo — el proxy transforma el payload server-side");
} else {
  console.log("❌ Sin datos suficientes");
}
