// Routing tests pin down WHY the router behaves as it does: a free local model decides,
// code owns the model mapping, and a broken router must never cost a paid call.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { route, modelForComplexity, type RouteConfig } from "../src/route.js";
import { mockFetch, restoreFetch, openaiReply } from "./helpers.js";

const config: RouteConfig = {
  classifierModel: "ollama/qwen2.5:7b",
  tiers: { cheap: "openrouter/deepseek/deepseek-chat", mid: "openrouter/minimax/minimax-m2", frontier: "anthropic/claude-sonnet-4-6" },
  defaultModel: "openrouter/minimax/minimax-m2",
  timeoutMs: 200,
};

const paidCalls = (log: { url: string }[]) => log.filter((l) => !l.url.includes("localhost:11434"));

afterEach(restoreFetch);

test("a simple request routes to the cheap tier", async () => {
  mockFetch({ "localhost:11434": openaiReply('{"complexity": 1, "reason": "greeting"}') });
  const r = await route("hi, what time zone is London in?", config);
  assert.equal(r.model, config.tiers.cheap);
  assert.equal(r.routed, true);
  assert.equal(r.complexity, 1);
});

test("a complex request routes to the frontier tier, even with chatter around the JSON", async () => {
  mockFetch({ "localhost:11434": openaiReply('Sure: {"complexity": 5, "reason": "long plan"}') });
  const r = await route("design a 90-day migration plan", config);
  assert.equal(r.model, config.tiers.frontier);
});

test("each complexity maps to exactly one tier", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((c) => modelForComplexity(c, config.tiers)), [
    config.tiers.cheap, config.tiers.cheap, config.tiers.mid, config.tiers.frontier, config.tiers.frontier,
  ]);
});

test("Ollama down → default model, and the router itself makes no paid call", async () => {
  const log = mockFetch({ "localhost:11434": new TypeError("fetch failed") });
  const r = await route("anything", config);
  assert.equal(r.model, config.defaultModel);
  assert.equal(r.routed, false);
  assert.deepEqual(paidCalls(log), []);
});

test("a slow classifier times out to the default instead of stalling the request", async () => {
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch; // never resolves
  const r = await route("anything", config);
  assert.equal(r.routed, false);
  assert.match(r.reason, /timeout/);
});

test("garbage or out-of-range replies fall back: the model can't pick its own tier", async () => {
  for (const reply of ["I think this is quite hard", '{"complexity": 9}', '{"complexity": "anthropic/claude-opus"}', '{"complexity": 2.5}']) {
    mockFetch({ "localhost:11434": openaiReply(reply) });
    const r = await route("x", config);
    assert.equal(r.model, config.defaultModel, reply);
    assert.equal(r.routed, false, reply);
  }
});

test("a classifier that is not a local model is refused up front", async () => {
  await assert.rejects(route("x", { ...config, classifierModel: "openrouter/openai/gpt-4o" }), /must be a local ollama\/ model/);
});

test("the classifier sees at most 2000 characters of the request", async () => {
  const log = mockFetch({ "localhost:11434": openaiReply('{"complexity": 2}') });
  await route("a".repeat(10_000), config);
  const body = log[0]!.body as { messages: { content: string }[] };
  assert.equal(body.messages[1]!.content.length, 2000);
});
