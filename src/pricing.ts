import type { Usage } from "./types.js";

/** USD per 1M tokens. `cachedInput` defaults to `input` when a provider has no cache discount. */
export interface Price {
  input: number;
  cachedInput?: number;
  output: number;
}

export type PriceTable = Record<string, Price>;

/** Cost of one call in USD, or null when the model has no price: never a silent zero. */
export function costUsd(model: string, usage: Usage, prices: PriceTable): number | null {
  const p = prices[model];
  if (!p) return null;
  const uncached = Math.max(0, usage.prompt - usage.cached);
  return (uncached * p.input + usage.cached * (p.cachedInput ?? p.input) + usage.completion * p.output) / 1_000_000;
}
