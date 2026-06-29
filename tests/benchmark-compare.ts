/**
 * benchmark-compare.ts — Automated cache hit rate comparison
 *   CleanCache (CommandCode proxy) vs DeepSeek API directa
 *
 * Usage:
 *   npx tsx tests/benchmark-compare.ts
 *
 * Prerequisites:
 *   - COMMANDCODE_API_KEY set in environment
 *   - DEEPSEEK_API_KEY set in environment (for direct comparison)
 *   - The extension compiled/loadable via ./src/index.ts
 *
 * How it works:
 *   Uses `pi --mode json` (non-interactive, one-shot) to send
 *   the same prompt N times against each provider and extracts
 *   usage metrics from the JSON event stream on stdout.
 *
 *   Turn 1 is warm-up (fills cache). Turns 2-N show cache benefit.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

// ── Config ──────────────────────────────────────────────────────────
const PROJECT_DIR = resolve(process.cwd());
const EXTENSION = resolve(PROJECT_DIR, "src/index.ts");
const WARMUP_RUNS = 1;
const MEASURED_RUNS = 4;
const TOTAL_RUNS = WARMUP_RUNS + MEASURED_RUNS;

const TEST_PROMPT =
  "List the files in the current directory and describe their purpose in one line.";

interface ProviderConfig {
  name: string;
  /** pi --model "<provider>/<model>" string */
  model: string;
  /** Whether to load the extension (-e flag) */
  useExtension: boolean;
  /** Env var override if different */
  env?: Record<string, string>;
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: "CleanCache (CommandCode)",
    model: "cleancache/deepseek/deepseek-v4-pro",
    useExtension: true,
  },
  {
    name: "DeepSeek API Directa",
    model: "deepseek/deepseek-v4-pro",
    useExtension: false,
  },
];

// ── Types ───────────────────────────────────────────────────────────
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface RunResult {
  run: number;
  usage: Usage;
  elapsedMs: number;
}

interface ProviderResults {
  config: ProviderConfig;
  runs: RunResult[];
  avgCH: number;
  chImprovement: number; // post warm-up
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractUsage(raw: string): Usage {
  const fallback: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastUsage: Usage | null = null;

  for (const rawLine of raw.split("\n").filter(Boolean)) {
    // Strip terminal OSC escape sequences (ESC ] ... BEL)
    const line = rawLine.replace(/\u001b\][0-9]+;.*?\u0007/g, "");
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
    } catch {
      /* skip non-JSON lines */
    }
  }

  return lastUsage ?? fallback;
}

function chRate(u: Usage): number {
  // Pi formula: CH = R / (input + R)
  const effective = u.input + u.cacheWrite;
  return effective > 0 ? (u.cacheRead / effective) * 100 : 0;
}

function formatUsage(u: Usage): string {
  const ch = chRate(u).toFixed(1);
  return (
    `↑${String(u.input).padStart(6)}  ` +
    `↓${String(u.output).padStart(6)}  ` +
    `R${String(u.cacheRead).padStart(6)}  ` +
    `W${String(u.cacheWrite).padStart(4)}  ` +
    `CH ${ch.padStart(5)}%`
  );
}

function runPi(
  config: ProviderConfig,
  prompt: string,
  runLabel: string,
): RunResult {
  const extFlag = config.useExtension ? `-e "${EXTENSION}"` : "";
  const cmd = `pi --mode json ${extFlag} --model "${config.model}" -p "${prompt}" 2>&1`;

  process.stdout.write(`  [${runLabel}] ${config.model} ... `);
  const start = Date.now();

  try {
    const raw = execSync(cmd, {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...config.env },
    });
    const elapsed = Date.now() - start;
    const usage = extractUsage(raw);
    console.log(`${formatUsage(usage)}  (${elapsed}ms)`);
    return { run: 0, usage, elapsedMs: elapsed };
  } catch (err: any) {
    const elapsed = Date.now() - start;
    console.log(`❌ ${err.message.slice(0, 100)}`);
    return {
      run: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      elapsedMs: elapsed,
    };
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(72));
  console.log("🧊  BENCHMARK: CleanCache vs DeepSeek API Directa");
  console.log("=".repeat(72));
  console.log(`Prompt:     "${TEST_PROMPT}"`);
  console.log(
    `Strategy:   ${TOTAL_RUNS} runs per provider ` +
      `(${WARMUP_RUNS} warm-up + ${MEASURED_RUNS} measured)`,
  );
  console.log("");

  const allResults: ProviderResults[] = [];

  for (const config of PROVIDERS) {
    console.log("-".repeat(72));
    console.log(`📡 Provider: ${config.name}`);
    console.log(`   Model:    ${config.model}`);
    console.log(`   Extension: ${config.useExtension ? "yes (CleanCache)" : "no (direct)"}`);
    console.log("");

    const runs: RunResult[] = [];

    for (let i = 0; i < TOTAL_RUNS; i++) {
      const label = i < WARMUP_RUNS ? `warm-up` : `#${i - WARMUP_RUNS + 1}`;
      const result = runPi(config, TEST_PROMPT, label);
      result.run = i + 1;
      runs.push(result);
    }

    const measured = runs.slice(WARMUP_RUNS);
    const rates = measured.map((r) => chRate(r.usage));
    const avgCH =
      rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    const warmupCH = runs.length > 0 ? chRate(runs[0].usage) : 0;
    const improvement = avgCH - warmupCH;

    allResults.push({ config, runs, avgCH, chImprovement: improvement });

    console.log("");
    console.log(
      `  📊 Avg CH (measured): ${avgCH.toFixed(1)}%  ` +
        `| Warm-up: ${warmupCH.toFixed(1)}%  ` +
        `| Δ: ${improvement >= 0 ? "+" : ""}${improvement.toFixed(1)}%`,
    );
    console.log("");
  }

  // ── Comparison table ──────────────────────────────────────────
  console.log("=".repeat(72));
  console.log("📊 COMPARISON TABLE");
  console.log("=".repeat(72));
  console.log("");

  // Header
  const colWidth = 25;
  const sep = "│";

  console.log(
    "Run  " +
      sep +
      " CleanCache (proxy)".padEnd(colWidth) +
      sep +
      " DeepSeek Direct".padEnd(colWidth),
  );
  console.log(
    "     " +
      sep +
      " ↑in     ↓out    Rcache  CH".padEnd(colWidth) +
      sep +
      " ↑in     ↓out    Rcache  CH".padEnd(colWidth),
  );
  console.log("-".repeat(72));

  const ccResults = allResults.find((r) => r.config.useExtension);
  const dsResults = allResults.find((r) => !r.config.useExtension);

  if (ccResults && dsResults) {
    const maxRuns = Math.max(ccResults.runs.length, dsResults.runs.length);
    for (let i = 0; i < maxRuns; i++) {
      const cc = ccResults.runs[i];
      const ds = dsResults.runs[i];

      const ccStr = cc
        ? formatUsage(cc.usage)
        : "—";
      const dsStr = ds
        ? formatUsage(ds.usage)
        : "—";

      const label =
        i < WARMUP_RUNS
          ? "WARM"
          : `  #${i - WARMUP_RUNS + 1}`;

      console.log(
        `${label}  ${sep} ${ccStr.padEnd(colWidth - 1)}${sep} ${dsStr.padEnd(colWidth - 1)}`,
      );
    }
  }

  // ── Overhead analysis ─────────────────────────────────────────
  console.log("");
  console.log("=".repeat(72));
  console.log("📈 OVERHEAD ANALYSIS");
  console.log("=".repeat(72));

  if (ccResults && dsResults) {
    const ccFirst = ccResults.runs[0]?.usage;
    const dsFirst = dsResults.runs[0]?.usage;

    if (ccFirst && dsFirst) {
      const overhead = ccFirst.input - dsFirst.input;
      const overheadPct = dsFirst.input > 0 ? (overhead / dsFirst.input) * 100 : 0;

      console.log("");
      console.log(`  First-turn input tokens:`);
      console.log(`    CleanCache (proxy):  ${ccFirst.input.toLocaleString()}`);
      console.log(`    DeepSeek (direct):   ${dsFirst.input.toLocaleString()}`);
      console.log(
        `    Proxy overhead:      ${overhead.toLocaleString()} tokens ` +
          `(${overheadPct >= 0 ? "+" : ""}${overheadPct.toFixed(0)}%)`,
      );
      console.log("");

      const ccCH = ccResults.avgCH;
      const dsCH = dsResults.avgCH;

      console.log(`  Avg Cache Hit Rate (measured runs):`);
      console.log(`    CleanCache (proxy):  ${ccCH.toFixed(1)}%`);
      console.log(`    DeepSeek (direct):   ${dsCH.toFixed(1)}%`);
      console.log(`    Difference:          ${(dsCH - ccCH).toFixed(1)} pts`);
      console.log("");

      if (overhead > 500) {
        console.log(
          "  ⚠️  The proxy adds significant structural overhead (~1.5-2k tokens).",
        );
        console.log(
          "     This is NOT a CleanCache bug — it's the /alpha/generate wrapper.",
        );
        console.log(
          "     CleanCache freezes this overhead so it's cacheable, but it can't",
        );
        console.log("     eliminate it. Only the direct API avoids this cost.");
      }
    }
  }

  // ── Verdict ───────────────────────────────────────────────────
  console.log("");
  console.log("=".repeat(72));
  console.log("🏁 VERDICT");
  console.log("=".repeat(72));
  console.log("");

  if (ccResults && dsResults) {
    const ccCH = ccResults.avgCH;
    const dsCH = dsResults.avgCH;
    const ratio = dsCH > 0 ? (ccCH / dsCH) * 100 : 0;

    console.log(
      `  CleanCache achieves ${ratio.toFixed(0)}% of direct API cache efficiency`,
    );

    if (ratio >= 80) {
      console.log("  🟢 Excellent — the proxy overhead is the only limiting factor.");
    } else if (ratio >= 50) {
      console.log("  🟡 Good — directionally correct, with some cache miss leakage.");
    } else {
      console.log("  🔴 The proxy may be mutating payloads server-side.");
    }

    console.log("");
    console.log("  Recommendation:");
    console.log("    - For max cache efficiency: use DeepSeek API directly.");
    console.log("    - For convenience + $1 plan: CleanCache is the best you can get.");
  } else {
    console.log("  ❌ Insufficient data for a verdict.");
  }

  console.log("");
}

main().catch(console.error);
