// Provider tests: each adapter reports usage in one shape, so cost can be computed the same way
// for every model, and reasoning-model <think> blocks never leak into the answer.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { callProvider, type ProviderEnv } from "../src/providers.js";
import { mockFetch, restoreFetch, openaiReply, anthropicReply } from "./helpers.js";

const env: ProviderEnv = { ollamaUrl: "http://localhost:11434", openrouterKey: "k", anthropicKey: "k", groqKey: "k", localContextTokens: 4096 };

afterEach(restoreFetch);

test("OpenRouter usage includes cached prompt tokens", async () => {
  mockFetch({
    "openrouter.ai": openaiReply("hi", { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 60 } } as never),
  });
  const c = await callProvider("openrouter/deepseek/deepseek-chat", [{ role: "user", content: "x" }], 50, env);
  assert.deepEqual(c.usage, { prompt: 100, cached: 60, completion: 9 });
});

test("Anthropic: system prompt goes in its own field, usage is normalised", async () => {
  const log = mockFetch({ "api.anthropic.com": anthropicReply("answer") });
  const c = await callProvider(
    "anthropic/claude-sonnet-4-6",
    [{ role: "system", content: "be brief" }, { role: "user", content: "q" }],
    50,
    env,
  );
  const body = log[0]!.body as { system: string; model: string; messages: unknown[] };
  assert.equal(body.system, "be brief");
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.messages.length, 1);
  assert.equal(c.text, "answer");
  assert.deepEqual(c.usage, { prompt: 24, cached: 4, completion: 7 });
});

test("<think> blocks are stripped from replies", async () => {
  mockFetch({ "localhost:11434": openaiReply("<think>long musing</think>42") });
  const c = await callProvider("ollama/deepseek-r1:7b", [{ role: "user", content: "x" }], 50, env);
  assert.equal(c.text, "42");
});

test("an unknown provider prefix is a hard error", async () => {
  await assert.rejects(callProvider("mystery/model", [{ role: "user", content: "x" }], 50, env), /unknown provider/);
});
