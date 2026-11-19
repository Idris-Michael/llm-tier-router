// Walk a chain of models: retryable failures (rate limit, outage, no credit, no key, local
// overflow, empty reply) move to the next model; anything else stops at once, because it
// would fail the same way on every provider and only multiply the cost.
import type { ChatMessage, Completion } from "./types.js";
import { callProvider, type CallOptions, type ProviderEnv } from "./providers.js";
import { isRetryable, ProvidersDownError } from "./errors.js";

export interface Attempt {
  model: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
}

export interface FallbackResult {
  completion: Completion;
  attempts: Attempt[];
}

export async function callWithFallback(
  chain: string[],
  messages: ChatMessage[],
  maxTokens: number,
  env: ProviderEnv,
  opts: CallOptions = {},
): Promise<FallbackResult> {
  const attempts: Attempt[] = [];
  let lastError = "no models in chain";
  for (const model of [...new Set(chain)]) {
    const started = performance.now();
    const latency = (): number => Math.round(performance.now() - started);
    try {
      const completion = await callProvider(model, messages, maxTokens, env, opts);
      if (completion.text.trim() === "") {
        lastError = `${model}: empty completion`;
        attempts.push({ model, ok: false, error: "empty completion", latencyMs: latency() });
        continue;
      }
      attempts.push({ model, ok: true, latencyMs: latency() });
      return { completion, attempts };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      attempts.push({ model, ok: false, error: message.slice(0, 200), latencyMs: latency() });
      if (!isRetryable(e)) throw e;
      lastError = message;
    }
  }
  throw new ProvidersDownError(`all models failed; last error: ${lastError}`);
}
