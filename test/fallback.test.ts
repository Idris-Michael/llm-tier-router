// Fallback tests: outages and rate limits move down the chain; real errors stop it,
// because walking every provider on a bad request just multiplies the failure (and the bill).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { callWithFallback } from "../src/fallback.js";
import { ProvidersDownError } from "../src/errors.js";
import type { ProviderEnv } from "../src/providers.js";
import { mockFetch, restoreFetch, openaiReply, anthropicReply } from "./helpers.js";

const env: ProviderEnv = {
  ollamaUrl: "http://localhost:11434",
  openrouterKey: "test-or",
  anthropicKey: "test-an",
  groqKey: "test-gq",
  localContextTokens: 4096,
};
const msgs = [{ role: "user" as const, content: "hello" }];

afterEach(restoreFetch);

test("a 429 moves to the next model", async () => {
  mockFetch({
    "openrouter.ai": { status: 429, body: { error: { message: "Rate limit exceeded" } } },
    "api.anthropic.com": anthropicReply("from sonnet"),
  });
  const r = await callWithFallback(["openrouter/x/cheap", "anthropic/claude-sonnet-4-6"], msgs, 100, env);
  assert.equal(r.completion.text, "from sonnet");
  assert.equal(r.completion.model, "anthropic/claude-sonnet-4-6");
  assert.deepEqual(r.attempts.map((a) => a.ok), [false, true]);
});

test("Groq's free-tier 413 counts as a rate limit, not a bad request", async () => {
  mockFetch({
    "api.groq.com": { status: 413, body: { error: { message: "Request too large for tokens per minute" } } },
    "openrouter.ai": openaiReply("ok"),
  });
  const r = await callWithFallback(["groq/llama-3.3-70b-versatile", "openrouter/x/y"], msgs, 100, env);
  assert.equal(r.completion.text, "ok");
});

test("a hard error (bad key, bad model id) stops the chain at once", async () => {
  const log = mockFetch({
    "openrouter.ai": { status: 401, body: { error: { message: "No auth credentials found" } } },
    "api.anthropic.com": anthropicReply("should not be reached"),
  });
  await assert.rejects(callWithFallback(["openrouter/x/y", "anthropic/claude-sonnet-4-6"], msgs, 100, env), /No auth credentials/);
  assert.equal(log.filter((l) => l.url.includes("anthropic")).length, 0);
});

test("an empty completion is treated as a failure and the next model is tried", async () => {
  mockFetch({ "openrouter.ai": openaiReply("   "), "localhost:11434": openaiReply("local answer") });
  const r = await callWithFallback(["openrouter/x/y", "ollama/qwen2.5:7b"], msgs, 100, env);
  assert.equal(r.completion.text, "local answer");
});

test("an oversized prompt for the local model moves on instead of being silently truncated", async () => {
  const log = mockFetch({ "openrouter.ai": openaiReply("cloud answer") });
  const big = [{ role: "user" as const, content: "x".repeat(4096 * 4) }];
  const r = await callWithFallback(["ollama/qwen2.5:7b", "openrouter/x/y"], big, 100, env);
  assert.equal(r.completion.text, "cloud answer");
  assert.match(r.attempts[0]!.error ?? "", /local context exceeded/);
  assert.equal(log.filter((l) => l.url.includes("11434")).length, 0, "Ollama must not receive a prompt it would truncate");
});

test("every provider down → ProvidersDownError naming the last failure", async () => {
  mockFetch({
    "openrouter.ai": { status: 503, body: { error: { message: "overloaded" } } },
    "localhost:11434": new TypeError("fetch failed"),
  });
  await assert.rejects(
    callWithFallback(["openrouter/x/y", "ollama/qwen2.5:7b"], msgs, 100, env),
    (e: unknown) => e instanceof ProvidersDownError && /fetch failed/.test(e.message),
  );
});

test("a model whose provider has no key is skipped, not called", async () => {
  const log = mockFetch({ "localhost:11434": openaiReply("local") });
  const r = await callWithFallback(["groq/llama", "ollama/qwen2.5:7b"], msgs, 100, { ...env, groqKey: undefined });
  assert.equal(r.completion.text, "local");
  assert.equal(log.filter((l) => l.url.includes("groq")).length, 0);
  assert.match(r.attempts[0]!.error ?? "", /no API key/);
});
