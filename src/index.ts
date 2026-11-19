import type { ChatMessage, Completion } from "./types.js";
import { route, type RouteConfig, type RouteDecision } from "./route.js";
import { callWithFallback, type Attempt } from "./fallback.js";
import { envFromProcess, type CallOptions } from "./providers.js";
import { costUsd, type PriceTable } from "./pricing.js";
import type { Telemetry } from "./telemetry.js";

export interface RouterConfig extends RouteConfig {
  /** Tried in order after the routed model fails with a retryable error. */
  fallbacks?: string[];
  prices?: PriceTable;
  telemetry?: Telemetry;
}

export interface RoutedCall {
  completion: Completion;
  decision: RouteDecision;
  attempts: Attempt[];
  /** Summed over every attempt that returned usage; null if the answering model is unpriced. */
  costUsd: number | null;
  latencyMs: number;
}

export interface CallMeta extends CallOptions {
  maxTokens?: number;
  /** Skip the classifier and use this model (still falls back on failure). */
  model?: string;
  taskId?: string;
  arm?: string;
}

const lastUserMessage = (messages: ChatMessage[]): string =>
  [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

export function createRouter(config: RouterConfig) {
  const env = config.env ?? envFromProcess();
  const prices = config.prices ?? {};

  return {
    route: (messages: ChatMessage[]): Promise<RouteDecision> => route(lastUserMessage(messages), { ...config, env }),

    async call(messages: ChatMessage[], meta: CallMeta = {}): Promise<RoutedCall> {
      const decision: RouteDecision = meta.model
        ? { model: meta.model, complexity: null, reason: "model pinned by caller", routed: false, routerMs: 0 }
        : await route(lastUserMessage(messages), { ...config, env });
      const started = performance.now();
      const log = (model: string, ok: boolean, error: string | null, completion?: Completion, cost: number | null = 0): void => {
        config.telemetry?.record({
          taskId: meta.taskId ?? null, arm: meta.arm ?? null, complexity: decision.complexity, routed: decision.routed,
          routeReason: decision.reason, model, promptTokens: completion?.usage.prompt ?? 0, cachedTokens: completion?.usage.cached ?? 0,
          completionTokens: completion?.usage.completion ?? 0, costUsd: cost, latencyMs: Math.round(performance.now() - started),
          routerMs: decision.routerMs, ok, error,
        });
      };
      try {
        const result = await callWithFallback([decision.model, ...(config.fallbacks ?? [])], messages, meta.maxTokens ?? 1024, env, meta);
        for (const a of result.attempts.filter((x) => !x.ok)) log(a.model, false, a.error ?? null);
        const cost = costUsd(result.completion.model, result.completion.usage, prices);
        log(result.completion.model, true, null, result.completion, cost);
        return { ...result, decision, costUsd: cost, latencyMs: Math.round(performance.now() - started) };
      } catch (e) {
        log(decision.model, false, (e as Error).message.slice(0, 200));
        throw e;
      }
    },
  };
}

export type Router = ReturnType<typeof createRouter>;
export { route, modelForComplexity, RUBRIC } from "./route.js";
export type { RouteConfig, RouteDecision } from "./route.js";
export { callWithFallback } from "./fallback.js";
export type { Attempt, FallbackResult } from "./fallback.js";
export { callProvider, envFromProcess, providerOf, measureClaudeCliOverhead } from "./providers.js";
export type { ProviderEnv, CallOptions, Provider } from "./providers.js";
export { createTelemetry } from "./telemetry.js";
export type { Telemetry, CallRecord, ModelSummary } from "./telemetry.js";
export { costUsd } from "./pricing.js";
export type { Price, PriceTable } from "./pricing.js";
export { ProviderError, ProvidersDownError, ContextOverflowError, MissingKeyError, isRetryable } from "./errors.js";
export type { ChatMessage, Completion, Usage, Tiers } from "./types.js";
