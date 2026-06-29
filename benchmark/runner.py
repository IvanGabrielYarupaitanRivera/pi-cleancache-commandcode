#!/usr/bin/env python3
"""
benchmark/runner.py — Master benchmark runner

Usage:
    python benchmark/runner.py [--provider cleancache] [--provider deepseek] [--runs 5]

Reads scenarios from benchmark/scenarios.yaml, runs each prompt N times
per provider, and reports median-based statistics.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import time
from collections import defaultdict

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENARIOS_PATH = os.path.join(PROJECT_DIR, "benchmark", "scenarios.yaml")
EXTENSION_PATH = os.path.join(PROJECT_DIR, "src", "index.ts")

# ── Config defaults ──────────────────────────────────────────────────
WARMUP_RUNS = 1
MEASURED_RUNS = 5  # por prompt
TIMEOUT_SEC = 300

# ── Provider definitions ─────────────────────────────────────────────
PROVIDERS = {
    "cleancache": {
        "name": "CleanCache (CommandCode)",
        "model": "cleancache/deepseek/deepseek-v4-flash",
        "use_extension": True,
    },
    "deepseek": {
        "name": "DeepSeek API Directa",
        "model": "deepseek/deepseek-v4-flash",
        "use_extension": False,
    },
}


# ── Helpers ──────────────────────────────────────────────────────────

def median(values):
    """Median of a list of numbers."""
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    mid = n // 2
    if n % 2 == 0:
        return (sorted_vals[mid - 1] + sorted_vals[mid]) / 2.0
    return float(sorted_vals[mid])


def load_scenarios(path):
    """Load prompts from YAML file (simple parser, no deps)."""
    import yaml  # try real yaml first
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return data
    except ImportError:
        pass

    # fallback: line-based parser for simple YAML
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    scenarios = {}
    current_category = None
    current_prompt = []
    in_block = False

    for line in content.split("\n"):
        stripped = line.rstrip()
        # category header: "short:"
        if stripped.endswith(":") and not stripped.startswith(" "):
            if current_category and current_prompt:
                text = "\n".join(current_prompt).strip()
                if text:
                    scenarios.setdefault(current_category, []).append(text)
            current_category = stripped[:-1]
            current_prompt = []
            in_block = False
        elif stripped.startswith("  - ") or stripped.startswith("  -"):
            # save previous prompt if any
            if current_prompt:
                text = "\n".join(current_prompt).strip()
                if text:
                    scenarios.setdefault(current_category, []).append(text)
            # start new prompt
            current_prompt = [stripped.lstrip(" -")]
            in_block = False
        elif stripped.startswith("    "):
            # continuation of a prompt (indented)
            if current_prompt is not None:
                current_prompt.append(stripped.strip())
            in_block = False
        elif stripped == "":
            pass  # blank lines between prompts

    # last prompt
    if current_category and current_prompt:
        text = "\n".join(current_prompt).strip()
        if text:
            scenarios.setdefault(current_category, []).append(text)

    return scenarios


def extract_usage(raw):
    """Extract usage from pi JSON event stream."""
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("\x1b]"):
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if evt.get("type") in ("message_end", "turn_end"):
            msg = evt.get("message", {})
            if msg.get("role") == "assistant":
                u = msg.get("usage", {})
                inp = u.get("input", 0)
                out = u.get("output", 0)
                if inp > 0 or out > 0:
                    return {
                        "input": inp,
                        "output": out,
                        "cacheRead": u.get("cacheRead", 0),
                        "cacheWrite": u.get("cacheWrite", 0),
                        "totalTokens": u.get("totalTokens", inp + out),
                    }
    return None


def compute_ch(usage):
    """Cache hit rate: R / (input + W) * 100."""
    denom = usage["input"] + usage["cacheWrite"]
    if denom > 0:
        return (usage["cacheRead"] / denom) * 100.0
    return 0.0


def compute_ch_clamped(usage):
    """Same but clamped to max 100% for display."""
    return min(compute_ch(usage), 100.0)


def run_pi(model, use_extension, prompt, label):
    """Execute a single pi command and return usage + latency."""
    ext_flag = f'-e "{EXTENSION_PATH}"' if use_extension else ""
    escaped_prompt = prompt.replace('"', '\\"')
    cmd = f'pi --mode json {ext_flag} --model "{model}" -p "{escaped_prompt}"'

    sys.stdout.write(f"    [{label}] running ... ")
    sys.stdout.flush()

    start = time.time()
    try:
        result = subprocess.run(
            cmd,
            cwd=PROJECT_DIR,
            shell=True,
            capture_output=True,
            text=False,
            timeout=TIMEOUT_SEC,
        )
        elapsed_ms = (time.time() - start) * 1000
        raw = result.stdout.decode("utf-8", errors="replace") + \
              result.stderr.decode("utf-8", errors="replace")
        usage = extract_usage(raw)

        if usage:
            ch = compute_ch(usage)
            print(
                f"IN {usage['input']:>6}  "
                f"OUT {usage['output']:>6}  "
                f"R {usage['cacheRead']:>6}  "
                f"W {usage['cacheWrite']:>4}  "
                f"CH {ch:>6.1f}%  "
                f"{elapsed_ms:7.0f}ms"
            )
            return {
                "input": usage["input"],
                "output": usage["output"],
                "cacheRead": usage["cacheRead"],
                "cacheWrite": usage["cacheWrite"],
                "ch": ch,
                "elapsed_ms": elapsed_ms,
            }
        else:
            print(f"No usage data  ({elapsed_ms:.0f}ms)")
            return None
    except subprocess.TimeoutExpired:
        elapsed_ms = (time.time() - start) * 1000
        print(f"TIMEOUT  ({elapsed_ms:.0f}ms)")
        return None


def run_prompts_for_provider(provider_key, prompts_by_category, runs_per_prompt):
    """Run all prompts for a single provider. Returns structured results."""
    cfg = PROVIDERS[provider_key]

    print("=" * 72)
    print(f"Provider: {cfg['name']}")
    print(f"  Model:       {cfg['model']}")
    print(f"  Extension:   {'yes (CleanCache)' if cfg['use_extension'] else 'no (direct)'}")
    print(f"  Runs/propmt: {runs_per_prompt} measured (+ {WARMUP_RUNS} warm-up)")
    print("")

    all_results = []

    for category in ["short", "medium", "long"]:
        prompts = prompts_by_category.get(category, [])
        if not prompts:
            continue

        print(f"\n--- Category: {category.upper()} ({len(prompts)} prompts) ---")
        cat_results = []

        for pidx, prompt in enumerate(prompts):
            print(f"\n  Prompt #{pidx + 1} [{category}] (len={len(prompt)} chars):")
            print(f"    \"{prompt[:80]}{'...' if len(prompt) > 80 else ''}\"")

            prompt_runs = []

            # Warm-up
            for w in range(WARMUP_RUNS):
                r = run_pi(cfg["model"], cfg["use_extension"], prompt, "warm-up")
                if r:
                    prompt_runs.append(r)

            # Measured
            for m in range(runs_per_prompt):
                r = run_pi(cfg["model"], cfg["use_extension"], prompt, f"run #{m + 1}")
                if r:
                    prompt_runs.append(r)

            if len(prompt_runs) > WARMUP_RUNS:
                measured = prompt_runs[WARMUP_RUNS:]
                ch_values = [r["ch"] for r in measured]
                lat_values = [r["elapsed_ms"] for r in measured]
                inp_values = [r["input"] for r in measured]
                out_values = [r["output"] for r in measured]
                cr_values = [r["cacheRead"] for r in measured]

                prompt_stats = {
                    "category": category,
                    "prompt_index": pidx,
                    "prompt_preview": prompt[:60],
                    "prompt_len_chars": len(prompt),
                    "measured_runs": len(measured),
                    "median_ch": median(ch_values),
                    "median_latency_ms": median(lat_values),
                    "median_input": median(inp_values),
                    "median_output": median(out_values),
                    "median_cacheRead": median(cr_values),
                    "all_ch": ch_values,
                    "all_latency_ms": lat_values,
                }
                cat_results.append(prompt_stats)
                all_results.append(prompt_stats)

                print(f"    >> Median CH: {prompt_stats['median_ch']:.1f}%  |  "
                      f"Median latency: {prompt_stats['median_latency_ms']:.0f}ms  |  "
                      f"Runs: {len(measured)}")
            else:
                print(f"    >> SKIP (no measured runs)")

        # Category summary
        if cat_results:
            cat_ch = [r["median_ch"] for r in cat_results]
            cat_lat = [r["median_latency_ms"] for r in cat_results]
            print(f"\n  == [{category.upper()}] Summary ==")
            print(f"     Median CH:      {median(cat_ch):.1f}%")
            print(f"     Median latency: {median(cat_lat):.0f}ms")
            print(f"     Prompts:        {len(cat_results)}")

    # Overall summary
    if all_results:
        overall_ch = [r["median_ch"] for r in all_results]
        overall_lat = [r["median_latency_ms"] for r in all_results]
        overall_inp = [r["median_input"] for r in all_results]

        print(f"\n  {'=' * 50}")
        print(f"  OVERALL ({len(all_results)} prompts × {runs_per_prompt} runs)")
        print(f"    Median CH:          {median(overall_ch):.1f}%")
        print(f"    Median latency:     {median(overall_lat):.0f}ms")
        print(f"    Median input:       {median(overall_inp):.0f} tokens")
        print(f"    Min CH:             {min(overall_ch):.1f}%")
        print(f"    Max CH:             {max(overall_ch):.1f}%")
        print(f"    Min latency:        {min(overall_lat):.0f}ms")
        print(f"    Max latency:        {max(overall_lat):.0f}ms")
        print("")

    return all_results


def print_comparison(results_by_provider):
    """Print side-by-side comparison table."""
    print("\n" + "=" * 72)
    print("  COMPARISON TABLE")
    print("=" * 72)

    providers = list(results_by_provider.keys())
    if len(providers) < 2:
        print("  (only one provider, no comparison)")
        return

    # Align prompts by index
    p0 = results_by_provider[providers[0]]
    p1 = results_by_provider[providers[1]]

    max_idx = max(len(p0), len(p1))

    print("")
    print(f"{'#':>3}  {'Category':<10}  {'CleanCache CH':>14}  {'CleanCache ms':>14}  "
          f"{'DeepSeek CH':>14}  {'DeepSeek ms':>14}  {'CH diff':>8}")
    print("-" * 85)

    for i in range(max_idx):
        r0 = p0[i] if i < len(p0) else None
        r1 = p1[i] if i < len(p1) else None

        cat = (r0 or r1).get("category", "?")[:10]

        ch0 = f"{r0['median_ch']:.1f}%" if r0 else "  N/A"
        ms0 = f"{r0['median_latency_ms']:.0f}" if r0 else "  N/A"
        ch1 = f"{r1['median_ch']:.1f}%" if r1 else "  N/A"
        ms1 = f"{r1['median_latency_ms']:.0f}" if r1 else "  N/A"

        diff = ""
        if r0 and r1:
            d = r0["median_ch"] - r1["median_ch"]
            diff = f"{d:+.1f}"

        print(f"{i + 1:>3}  {cat:<10}  {ch0:>14}  {ms0:>14}  "
              f"{ch1:>14}  {ms1:>14}  {diff:>8}")

    # Averages
    if len(p0) > 0 and len(p1) > 0:
        avg_ch0 = median([r["median_ch"] for r in p0])
        avg_ms0 = median([r["median_latency_ms"] for r in p0])
        avg_ch1 = median([r["median_ch"] for r in p1])
        avg_ms1 = median([r["median_latency_ms"] for r in p1])
        print("-" * 85)
        print(f"{'MED':>3}  {'overall':<10}  {avg_ch0:>14.1f}%  {avg_ms0:>14.0f}  "
              f"{avg_ch1:>14.1f}%  {avg_ms1:>14.0f}  {avg_ch0 - avg_ch1:>+8.1f}")


def save_report(results_by_provider, output_path):
    """Save JSON report."""
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "config": {
            "warmup_runs": WARMUP_RUNS,
            "measured_runs": MEASURED_RUNS,
            "timeout_sec": TIMEOUT_SEC,
        },
        "providers": {},
    }

    for key, results in results_by_provider.items():
        cfg = PROVIDERS[key]
        all_ch = [r["median_ch"] for r in results]
        all_lat = [r["median_latency_ms"] for r in results]
        all_inp = [r["median_input"] for r in results]

        report["providers"][key] = {
            "name": cfg["name"],
            "model": cfg["model"],
            "use_extension": cfg["use_extension"],
            "overall": {
                "median_ch": round(median(all_ch), 1),
                "median_latency_ms": round(median(all_lat), 1),
                "median_input_tokens": round(median(all_inp), 0),
                "min_ch": round(min(all_ch), 1),
                "max_ch": round(max(all_ch), 1),
                "min_latency_ms": round(min(all_lat), 1),
                "max_latency_ms": round(max(all_lat), 1),
                "num_prompts": len(results),
            },
            "prompts": results,
        }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\nReport saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Master benchmark runner")
    parser.add_argument(
        "--provider", action="append", dest="providers",
        choices=["cleancache", "deepseek"], default=[],
        help="Provider(s) to benchmark. Repeat for multiple. Default: all."
    )
    parser.add_argument(
        "--runs", type=int, default=MEASURED_RUNS,
        help=f"Measured runs per prompt (default: {MEASURED_RUNS})"
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Path to save JSON report (default: benchmark/results/run-<timestamp>.json)"
    )
    args = parser.parse_args()

    providers = args.providers if args.providers else ["cleancache", "deepseek"]

    # Load scenarios
    if not os.path.exists(SCENARIOS_PATH):
        print(f"ERROR: scenarios file not found: {SCENARIOS_PATH}")
        sys.exit(1)

    scenarios = load_scenarios(SCENARIOS_PATH)
    total_prompts = sum(len(v) for v in scenarios.values())
    print(f"Loaded {total_prompts} prompts from {SCENARIOS_PATH}")
    print(f"Categories: {', '.join(scenarios.keys())}")
    print("")

    # Run for each provider
    results_by_provider = {}
    for pk in providers:
        results = run_prompts_for_provider(pk, scenarios, args.runs)
        results_by_provider[pk] = results

    # Comparison
    if len(providers) >= 2:
        print_comparison(results_by_provider)

    # Save report
    timestamp = time.strftime("%Y%m%d_%H%M%S", time.localtime())
    output_dir = os.path.join(PROJECT_DIR, "benchmark", "results")
    os.makedirs(output_dir, exist_ok=True)
    output_path = args.output or os.path.join(output_dir, f"run_{timestamp}.json")
    save_report(results_by_provider, output_path)

    print("\nDone.")


if __name__ == "__main__":
    main()
