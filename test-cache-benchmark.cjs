/**
 * Cache Hit Rate Benchmark — CleanCache
 * CommonJS version (works with tsx/npx)
 */
const { execSync } = require("node:child_process");
const { resolve } = require("node:path");

const PROJECT_DIR = resolve(process.cwd());
const EXTENSION = resolve(PROJECT_DIR, "src/index.ts");
const ITERATIONS = 6;
const TEST_PROMPT = "List the files in the current directory and describe their purpose in one line.";

function extractUsage(raw) {
  const fallback = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastUsage = null;

  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === "message_end" && evt.message?.role === "assistant") {
        const u = evt.message.usage;
        if (u && (u.input || u.output || u.cacheRead)) {
          lastUsage = {
            input: u.input ?? u.input_tokens ?? 0,
            output: u.output ?? u.output_tokens ?? 0,
            cacheRead: u.cacheRead ?? u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cacheWrite ?? u.cache_creation_input_tokens ?? 0,
          };
        }
      }
    } catch (_) { /* skip */ }
  }

  return lastUsage ?? fallback;
}

function chRate(u) {
  const effective = u.input + u.cacheWrite;
  return effective > 0 ? (u.cacheRead / effective) * 100 : 0;
}

function fmt(u) {
  const pct = chRate(u).toFixed(1);
  return (
    `↑${String(u.input).padStart(6)}  ` +
    `↓${String(u.output).padStart(6)}  ` +
    `R${String(u.cacheRead).padStart(6)}  ` +
    `W${String(u.cacheWrite).padStart(4)}  ` +
    `CH ${pct.padStart(5)}%`
  );
}

async function main() {
  const provider = "cleancache";
  const model = "deepseek/deepseek-v4-flash";

  // Quick connectivity check
  console.log("🔍 Checking connectivity…");
  try {
    const testCmd = `pi --mode json -e "${EXTENSION}" --model "${provider}/${model}" -p "test" 2>&1`;
    const testRaw = execSync(testCmd, {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const testUsage = extractUsage(testRaw);
    if (testUsage.input === 0 && testUsage.output === 0) {
      if (testRaw.includes("error") || testRaw.includes("Error") || testRaw.includes("COMMANDCODE_API_KEY")) {
        console.log("❌ Connectivity failed — check API key and provider.\n");
        console.log(testRaw.slice(0, 1000));
        process.exit(1);
      }
    }
    console.log(`✅ Connection OK — input=${testUsage.input} output=${testUsage.output}\n`);
  } catch (err) {
    console.log(`❌ Connectivity failed: ${err.message.slice(0, 200)}\n`);
    console.log("Tip: Ensure COMMANDCODE_API_KEY is set and the extension loads.");
    process.exit(1);
  }

  // Run benchmark
  console.log("=".repeat(70));
  console.log("🧊 CleanCache — Cache Hit Rate Benchmark");
  console.log("=".repeat(70));
  console.log(`Provider: ${provider}`);
  console.log(`Model:    ${model}`);
  console.log(`Prompt:   "${TEST_PROMPT}"`);
  console.log(`Runs:     ${ITERATIONS} (1 warm-up + ${ITERATIONS - 1} measured)`);
  console.log("");

  const results = [];

  for (let i = 0; i < ITERATIONS; i++) {
    process.stdout.write(`  [${i + 1}/${ITERATIONS}] ${model} ... `);
    const cmd = `pi --mode json -e "${EXTENSION}" --model "${provider}/${model}" -p "${TEST_PROMPT}" 2>&1`;
    try {
      const raw = execSync(cmd, {
        cwd: PROJECT_DIR,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const usage = extractUsage(raw);
      results.push(usage);
      console.log(fmt(usage));
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 80)}`);
    }
  }

  console.log("");
  console.log("-".repeat(70));
  console.log("📊 RESULTADOS:");
  console.log("-".repeat(70));

  if (results.length >= 2) {
    const measured = results.slice(1);
    const rates = measured.map(chRate);
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;

    console.log(`  Warm-up   → ${fmt(results[0])}`);
    for (let i = 0; i < measured.length; i++) {
      console.log(`  Req #${i + 2} → ${fmt(measured[i])}`);
    }
    console.log("");
    console.log(`  🎯 Cache Hit Rate PROMEDIO (post warm-up): ${avg.toFixed(1)}%`);

    if (avg >= 85) {
      console.log(`  🟢 CleanCache funciona — caché estable ≥85%`);
    } else if (avg >= 60) {
      console.log(`  🟡 CleanCache ayuda — pero aún hay fugas (${(100 - avg).toFixed(0)}% miss)`);
    } else {
      console.log(`  🔴 Bajo hit rate — CommandCode probablemente transforma el payload server-side`);
    }
  } else {
    console.log("  ❌ No hay datos suficientes.");
  }

  console.log("");
}

main().catch(console.error);
