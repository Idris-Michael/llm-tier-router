// A free local model scores how hard a request is (1–5); code maps the score to a model.
// The classifier only decides, it never answers. Any failure keeps the default model and
// never spends money: the classifier must be a local ollama/ model, checked up front.
import type { Tiers } from "./types.js";
import { callProvider, envFromProcess, type ProviderEnv } from "./providers.js";

export interface RouteConfig {
  /** Must be a local model, e.g. "ollama/qwen2.5:7b". */
  classifierModel: string;
  tiers: Tiers;
  /** Used whenever the classifier fails, times out or replies with nonsense. */
  defaultModel: string;
  timeoutMs?: number;
  env?: ProviderEnv;
}

export interface RouteDecision {
  model: string;
  complexity: number | null;
  reason: string;
  routed: boolean;
  routerMs: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const CLASSIFIER_MAX_TOKENS = 60;
const MAX_CLASSIFIED_CHARS = 2000;

export const RUBRIC = `Rate how hard this request is for an AI assistant. Reply with ONLY JSON: {"complexity": <1-5>, "reason": "<max 8 words>"}
1 = greeting, lookup, simple fact, yes/no
2 = single short task: rewrite, reformat, extract, classify
3 = multi-step task, moderate writing or arithmetic over several steps
4 = non-trivial code, careful analysis, a client-ready deliverable
5 = deep multi-part reasoning, architecture, long plan`;

/** Complexity → model lives in code, so the classifier can never pick an arbitrary (or paid) model. */
export function modelForComplexity(complexity: number, tiers: Tiers): string {
  if (complexity <= 2) return tiers.cheap;
  if (complexity === 3) return tiers.mid;
  return tiers.frontier;
}

export async function route(request: string, config: RouteConfig): Promise<RouteDecision> {
  if (!config.classifierModel.startsWith("ollama/")) {
    throw new Error(`classifierModel must be a local ollama/ model, got "${config.classifierModel}"`);
  }
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const fallback = (reason: string): RouteDecision => ({ model: config.defaultModel, complexity: null, reason, routed: false, routerMs: elapsed() });

  let raw: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = callProvider(
      config.classifierModel,
      [{ role: "system", content: RUBRIC }, { role: "user", content: request.slice(0, MAX_CLASSIFIED_CHARS) }],
      CLASSIFIER_MAX_TOKENS,
      config.env ?? envFromProcess(),
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    raw = (await Promise.race([call, timeout])).text;
  } catch (e) {
    return fallback(`classifier failed: ${(e as Error).message.slice(0, 80)}`);
  } finally {
    clearTimeout(timer);
  }

  let parsed: { complexity?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "");
  } catch {
    return fallback(`unparseable reply: ${raw.slice(0, 80)}`);
  }
  const c = Number(parsed.complexity);
  if (!Number.isInteger(c) || c < 1 || c > 5) return fallback(`complexity out of range: ${String(parsed.complexity).slice(0, 40)}`);

  return { model: modelForComplexity(c, config.tiers), complexity: c, reason: String(parsed.reason ?? "").slice(0, 80), routed: true, routerMs: elapsed() };
}
