// Turns one benchmark run into the numbers the README quotes.
import type { Kind } from "./tasks.js";

export interface TaskResult {
  taskId: string;
  kind: Kind;
  arm: "frontier" | "routed";
  model: string;
  complexity: number | null;
  routed: boolean;
  passed: boolean;
  error: string | null;
  costUsd: number;
  unpriced: boolean;
  latencyMs: number;
  routerMs: number;
  reply: string;
}

export interface ArmSummary {
  tasks: number;
  passed: number;
  successRate: number;
  errors: number;
  costUsd: number;
  costPerTaskUsd: number;
  unpricedCalls: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface Report {
  arms: Partial<Record<TaskResult["arm"], ArmSummary>>;
  /** 1 − routed cost ÷ frontier cost, over the tasks both arms ran. */
  costSaving: number | null;
  byKind: Record<string, { frontier: number | null; routed: number | null; routedModels: Record<string, number> }>;
  routing: { byComplexity: Record<string, number>; byModel: Record<string, number>; classifierFallbacks: number; avgRouterMs: number };
  /** Frontier passed, routed failed on a cheaper model: the cost of routing. */
  misroutes: { taskId: string; kind: Kind; model: string; complexity: number | null }[];
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

const count = <T>(xs: T[], key: (x: T) => string): Record<string, number> =>
  xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});

function summarise(rs: TaskResult[]): ArmSummary {
  const passed = rs.filter((r) => r.passed).length;
  const cost = rs.reduce((a, r) => a + r.costUsd, 0);
  return {
    tasks: rs.length, passed, successRate: rs.length ? passed / rs.length : 0, errors: rs.filter((r) => r.error).length,
    costUsd: cost, costPerTaskUsd: rs.length ? cost / rs.length : 0, unpricedCalls: rs.filter((r) => r.unpriced).length,
    p50LatencyMs: pct(rs.map((r) => r.latencyMs), 50), p95LatencyMs: pct(rs.map((r) => r.latencyMs), 95),
  };
}

export function buildReport(results: TaskResult[], frontierModel: string): Report {
  const frontier = results.filter((r) => r.arm === "frontier");
  const routed = results.filter((r) => r.arm === "routed");
  const both = new Set(frontier.map((r) => r.taskId).filter((id) => routed.some((r) => r.taskId === id)));
  const costOn = (rs: TaskResult[]): number => rs.filter((r) => both.has(r.taskId)).reduce((a, r) => a + r.costUsd, 0);
  const frontierCost = costOn(frontier);

  const kinds = [...new Set(results.map((r) => r.kind))];
  const rate = (rs: TaskResult[]): number | null => (rs.length ? rs.filter((r) => r.passed).length / rs.length : null);
  const byKind = Object.fromEntries(kinds.map((k) => [k, {
    frontier: rate(frontier.filter((r) => r.kind === k)),
    routed: rate(routed.filter((r) => r.kind === k)),
    routedModels: count(routed.filter((r) => r.kind === k), (r) => r.model),
  }]));

  const passedOnFrontier = new Set(frontier.filter((r) => r.passed).map((r) => r.taskId));
  return {
    arms: {
      ...(frontier.length ? { frontier: summarise(frontier) } : {}),
      ...(routed.length ? { routed: summarise(routed) } : {}),
    },
    costSaving: frontierCost > 0 ? 1 - costOn(routed) / frontierCost : null,
    byKind,
    routing: {
      byComplexity: count(routed, (r) => String(r.complexity ?? "fallback")),
      byModel: count(routed, (r) => r.model),
      classifierFallbacks: routed.filter((r) => !r.routed).length,
      avgRouterMs: routed.length ? Math.round(routed.reduce((a, r) => a + r.routerMs, 0) / routed.length) : 0,
    },
    misroutes: routed
      .filter((r) => !r.passed && passedOnFrontier.has(r.taskId) && r.model !== frontierModel)
      .map((r) => ({ taskId: r.taskId, kind: r.kind, model: r.model, complexity: r.complexity })),
  };
}

const usd = (n: number): string => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(3)}`;
const p = (n: number | null): string => (n === null ? "–" : `${Math.round(n * 100)}%`);

export function toMarkdown(rep: Report, meta: Record<string, string>): string {
  const lines = [
    "# Benchmark results", "",
    ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`), "",
    "| Arm | Tasks | Success | Errors | Cost | Cost / task | p50 latency | p95 latency |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(rep.arms).map(([arm, s]) =>
      `| ${arm} | ${s.tasks} | ${p(s.successRate)} | ${s.errors} | ${usd(s.costUsd)}${s.unpricedCalls ? ` (+${s.unpricedCalls} unpriced)` : ""} | ${usd(s.costPerTaskUsd)} | ${(s.p50LatencyMs / 1000).toFixed(1)} s | ${(s.p95LatencyMs / 1000).toFixed(1)} s |`),
    ...(rep.costSaving === null ? [] : ["", `**Cost saving from routing: ${p(rep.costSaving)}**`]), "",
    "## Success by task kind", "",
    "| Kind | Frontier | Routed | Routed to |", "| --- | ---: | ---: | --- |",
    ...Object.entries(rep.byKind).map(([k, v]) =>
      `| ${k} | ${p(v.frontier)} | ${p(v.routed)} | ${Object.entries(v.routedModels).map(([m, n]) => `${m.split("/").pop()} ×${n}`).join(", ")} |`),
    "", "## Routing", "",
    `- Complexity scores: ${Object.entries(rep.routing.byComplexity).sort().map(([c, n]) => `${c}: ${n}`).join(" · ")}`,
    `- Classifier fallbacks (default model used): ${rep.routing.classifierFallbacks}`,
    `- Average classifier time: ${rep.routing.avgRouterMs} ms`,
    `- Misroutes (frontier passed, cheaper model failed): ${rep.misroutes.length}`,
    ...rep.misroutes.map((m) => `  - ${m.taskId} (${m.kind}) → ${m.model.split("/").pop()}, complexity ${m.complexity ?? "fallback"}`),
  ];
  return lines.join("\n") + "\n";
}
