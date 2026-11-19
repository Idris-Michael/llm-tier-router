/** An HTTP or transport failure from one provider. `status` is the HTTP status when there was one. */
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The local model was asked for more than its context window holds. Thrown instead of letting
 *  Ollama silently drop the overflow, which makes the model invent whatever it lost. */
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

/** The provider for this model has no API key configured, so it was skipped without a call. */
export class MissingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingKeyError";
  }
}

/** Every model in the chain failed with a retryable error. */
export class ProvidersDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvidersDownError";
  }
}

const RETRYABLE_STATUS = new Set([402, 403, 408, 429, 500, 502, 503, 504, 529]);

const RETRYABLE_TEXT = [
  "rate limit", "too many requests", "quota", "overloaded", "throttl", "insufficient", "credit",
  "balance", "key limit", "limit exceeded", "econnrefused", "connection refused", "connection error",
  "fetch failed", "timed out", "timeout", "enotfound", "network error", "socket hang up",
];

/**
 * True when the next model in the chain might succeed: rate limits, outages, exhausted credit,
 * network failures, a local context overflow or a missing key. False for errors that would fail
 * the same way everywhere (bad request, bad auth on a configured key, unknown model id).
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ContextOverflowError || err instanceof MissingKeyError) return true;
  if (!(err instanceof Error)) return false;
  const status = err instanceof ProviderError ? err.status : undefined;
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  const cause = err.cause instanceof Error ? err.cause.message : String(err.cause ?? "");
  const text = `${err.message} ${cause}`.toLowerCase();
  if (status === 400) return ["limit", "credit", "quota"].some((w) => text.includes(w));
  if (status !== undefined && status >= 400 && status < 500) return false;
  return RETRYABLE_TEXT.some((w) => text.includes(w));
}
