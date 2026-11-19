// Benchmark: the same tasks through two arms — "frontier" (every task to the frontier model)
// and "routed" (local classifier picks the tier) — graded in code, costed per call.
//   npm run bench -- --dry-run            estimate cost, call nothing
//   npm run bench -- --tasks 10           first 10 tasks of each kind... (stratified)
//   npm run bench -- --local              smoke test on free local models only
//   npm run bench -- --max-usd 3          stop scheduling once spend passes $3
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createRouter, createTelemetry, type PriceTable, type Tiers } from "../src/index.js";
import { buildTasks, SYSTEM_PROMPT, type Task } from "./tasks.js";
import { grade } from "./graders.js";
import { buildReport, toMarkdown, type TaskResult } from "./report.js";

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    local: { type: "boolean", default: false },
    tasks: { type: "string" },
    "max-usd": { type: "string", default: "3" },
    concurrency: { type: "string", default: "4" },
    arms: { type: "string", default: "frontier,routed" },
    seed: { type: "string", default: "7" },
    publish: { type: "boolean", default: false },
  },
});

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const prices = (JSON.parse(readFileSync(here("../prices.json"), "utf8")) as { prices: PriceTable }).prices;

const PAID: { tiers: Tiers; default: string } = {
  tiers: {
    cheap: process.env.BENCH_CHEAP ?? "openrouter/deepseek/deepseek-v4.1-flash",
    mid: process.env.BENCH_MID ?? "openrouter/minimax/minimax-m2.7",
    frontier: process.env.BENCH_FRONTIER ?? "openrouter/anthropic/claude-sonnet-5.5",
  },
  default: process.env.BENCH_DEFAULT ?? "openrouter/minimax/minimax-m2.7",
};
// Smoke test: proves the pipeline end to end for free. Its numbers mean nothing about cost.
const LOCAL: typeof PAID = {
  tiers: { cheap: "ollama/qwen2.5:7b", mid: "ollama/qwen2.5:7b", frontier: "ollama/gemma4:e4b" },
  default: "ollama/qwen2.5:7b",
};
const setup = args.local ? LOCAL : PAID;
const classifierModel = process.env.BENCH_CLASSIFIER ?? "ollama/qwen2.5:7b";
const arms = args.arms.split(",") as TaskResult["arm"][];
const maxUsd = Number(args["max-usd"]);
const MAX_TOKENS = 4096;

/** Take n tasks of each kind so a short run still covers easy and hard work. */
function sample(tasks: Task[], perKind: number | undefined): Task[] {
  if (!perKind) return tasks;
  const kinds = [...new Set(tasks.map((t) => t.kind))];
  return kinds.flatMap((k) => tasks.filter((t) => t.kind === k).slice(0, perKind));
}
const tasks = sample(buildTasks({ seed: Number(args.seed) }), args.tasks ? Number(args.tasks) : undefined);

// Output allowance per kind, ×3 because reasoning models spend hidden tokens. An upper bound.
const OUT_TOKENS: Record<Task["kind"], number> = { extract: 60, arithmetic: 150, json: 120, date: 300, gsm8k: 400, ordering: 900 };
function estimate(): number {
  const p = prices[setup.tiers.frontier];
  if (!p) throw new Error(`no price for ${setup.tiers.frontier} in prices.json`);
  const perArm = tasks.reduce((a, t) => a + (((SYSTEM_PROMPT.length + t.prompt.length) / 4) * p.input + OUT_TOKENS[t.kind] * 3 * p.output) / 1e6, 0);
  return perArm * arms.length; // routed arm bounded by "everything went to frontier"
}

if (args["dry-run"]) {
  console.log(`${tasks.length} tasks × ${arms.length} arms (${arms.join(", ")})`);
  console.log(`tiers: ${JSON.stringify(setup.tiers)} · classifier ${classifierModel}`);
  console.log(`upper-bound cost estimate: $${estimate().toFixed(2)} (cap --max-usd ${maxUsd})`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = here(`./runs/${stamp}${args.local ? "-local" : ""}`);
mkdirSync(runDir, { recursive: true });
const telemetry = createTelemetry(`${runDir}/calls.db`);
const router = createRouter({ classifierModel, tiers: setup.tiers, defaultModel: setup.default, prices, telemetry, fallbacks: [] });

let spent = 0;
let aborted = false;
const results: TaskResult[] = [];
// One arm at a time, so local models are not swapped in and out of GPU memory between calls.
const jobs = arms.flatMap((arm) => tasks.map((t) => ({ t, arm })));

// A cold Ollama load (~4.5 s) is longer than the classifier's 3 s timeout, so the first routed
// calls would fall back to the default model. Load the classifier once before timing anything.
if (arms.includes("routed")) {
  const warm = await router.route([{ role: "user", content: "warm-up" }]);
  console.log(`classifier warm-up: ${warm.routed ? "ok" : warm.reason} (${warm.routerMs} ms)`);
}
let next = 0;
let done = 0;

async function worker(): Promise<void> {
  while (next < jobs.length) {
    if (spent >= maxUsd) { aborted = true; return; }
    const { t, arm } = jobs[next++]!;
    const messages = [{ role: "system" as const, content: SYSTEM_PROMPT }, { role: "user" as const, content: t.prompt }];
    const started = performance.now();
    let r: TaskResult;
    try {
      const out = await router.call(messages, { maxTokens: MAX_TOKENS, taskId: t.id, arm, ...(arm === "frontier" ? { model: setup.tiers.frontier } : {}) });
      spent += out.costUsd ?? 0;
      r = {
        taskId: t.id, kind: t.kind, arm, model: out.completion.model, complexity: out.decision.complexity, routed: out.decision.routed,
        passed: grade(t, out.completion.text), error: null, costUsd: out.costUsd ?? 0, unpriced: out.costUsd === null,
        latencyMs: out.latencyMs + out.decision.routerMs, routerMs: out.decision.routerMs, reply: out.completion.text.slice(-400),
      };
    } catch (e) {
      r = {
        taskId: t.id, kind: t.kind, arm, model: arm === "frontier" ? setup.tiers.frontier : "error", complexity: null, routed: false,
        passed: false, error: (e as Error).message.slice(0, 200), costUsd: 0, unpriced: false,
        latencyMs: Math.round(performance.now() - started), routerMs: 0, reply: "",
      };
    }
    results.push(r);
    appendFileSync(`${runDir}/results.jsonl`, JSON.stringify(r) + "\n");
    done++;
    process.stdout.write(`\r${done}/${jobs.length} · $${spent.toFixed(4)} · ${r.arm.padEnd(8)} ${r.taskId.padEnd(14)} ${r.passed ? "pass" : r.error ? "ERROR" : "fail"}   `);
  }
}

await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
telemetry.close();

const report = buildReport(results, setup.tiers.frontier);
const meta = {
  Date: new Date().toISOString().slice(0, 10),
  Mode: args.local ? "LOCAL SMOKE TEST (free models; not a cost result)" : "paid",
  Tasks: `${tasks.length} (seed ${args.seed})${aborted ? ` — ABORTED at $${spent.toFixed(2)} cap, ${results.length}/${jobs.length} calls` : ""}`,
  Classifier: classifierModel,
  Tiers: `cheap ${setup.tiers.cheap} · mid ${setup.tiers.mid} · frontier ${setup.tiers.frontier}`,
  Prices: `prices.json, as of ${(JSON.parse(readFileSync(here("../prices.json"), "utf8")) as { _asOf: string })._asOf}`,
};
const md = toMarkdown(report, meta);
writeFileSync(`${runDir}/report.json`, JSON.stringify({ meta, report }, null, 2));
writeFileSync(`${runDir}/report.md`, md);
if (args.publish && !args.local && !aborted) {
  writeFileSync(here("./results.json"), JSON.stringify({ meta, report }, null, 2));
  writeFileSync(here("./results.md"), md);
}
console.log(`\n\n${md}\nRun files: ${runDir}`);
