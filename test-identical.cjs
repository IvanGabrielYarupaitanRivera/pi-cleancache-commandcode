const { execSync } = require("child_process");
const EXT = __dirname + "/src/index.ts";
const MODEL = "cleancache/deepseek/deepseek-v4-flash";
const PROMPT = "What is 2+2 Just answer the number";
const RUNS = 8;

function extractUsage(raw) {
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "message_end" && evt.message?.role === "assistant") {
        const u = evt.message.usage;
        if (u && u.input > 0) return u;
      }
    } catch(_) {}
  }
  return null;
}

console.log("=== IDENTICAL prompt " + RUNS + " times ===\n");
const results = [];

for (let i = 0; i < RUNS; i++) {
  const cmd = `pi --mode json -e "${EXT}" --model "${MODEL}" -p "${PROMPT}" 2>&1`;
  try {
    const raw = execSync(cmd, { encoding: "utf-8", timeout: 120_000, maxBuffer: 10*1024*1024, shell: true });
    const u = extractUsage(raw);
    if (u) {
      results.push(u);
      const eff = (u.input||0) + (u.cacheWrite||0);
      const ch = eff > 0 ? ((u.cacheRead||0) / eff * 100).toFixed(1) : "0.0";
      console.log("  ["+(i+1)+"/"+RUNS+"] input="+u.input+" cacheRead="+u.cacheRead+" CH="+ch+"%");
    } else {
      console.log("  ["+(i+1)+"/"+RUNS+"] no usage");
    }
  } catch(e) {
    console.log("  ["+(i+1)+"/"+RUNS+"] " + e.message.slice(0,80));
  }
}

if (results.length >= 2) {
  const measured = results.slice(1);
  const rates = measured.map(u => {
    const eff = (u.input||0) + (u.cacheWrite||0);
    return eff > 0 ? ((u.cacheRead||0) / eff) * 100 : 0;
  });
  const avg = rates.reduce((a,b) => a+b, 0) / rates.length;
  console.log("\n---");
  console.log("Warm-up: CH " + (results[0].cacheRead / ((results[0].input||0)+(results[0].cacheWrite||0)) * 100).toFixed(1) + "%");
  measured.forEach((u,i) => {
    const eff = (u.input||0) + (u.cacheWrite||0);
    const pct = eff > 0 ? (u.cacheRead/eff*100).toFixed(1) : "0.0";
    console.log("Req #" + (i+2) + ": CH " + pct + "%");
  });
  console.log("AVG CH (post warm-up): " + avg.toFixed(1) + "%");
  if (avg >= 85) console.log("\n✅ Frozen prefix FUNCIONA — CommandCode NO transforma el payload");
  else console.log("\n❌ Bajo CH incluso con prompts identicos — CommandCode TRANSFORMA server-side");
}
