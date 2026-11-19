// Telemetry tests: logging must never break a request, and the summary must give the numbers
// a cost claim rests on (calls, success rate, spend, latency) per model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetry, type CallRecord } from "../src/telemetry.js";
import { costUsd, type PriceTable } from "../src/pricing.js";

const row = (over: Partial<CallRecord> = {}): CallRecord => ({
  taskId: "t1", arm: "routed", complexity: 2, routed: true, routeReason: "short", model: "openrouter/x/cheap",
  promptTokens: 100, cachedTokens: 0, completionTokens: 20, costUsd: 0.0001, latencyMs: 400, routerMs: 120, ok: true, error: null,
  ...over,
});

test("records calls and summarises spend, success and latency per model", () => {
  const dir = mkdtempSync(join(tmpdir(), "ltr-"));
  try {
    const t = createTelemetry(join(dir, "calls.db"));
    assert.equal(t.record(row()), true);
    assert.equal(t.record(row({ ok: false, error: "429", costUsd: 0, latencyMs: 100 })), true);
    assert.equal(t.record(row({ model: "anthropic/claude-sonnet-4-6", costUsd: 0.01 })), true);
    const s = t.summary();
    const cheap = s.find((r) => r.model === "openrouter/x/cheap")!;
    assert.equal(cheap.calls, 2);
    assert.equal(cheap.successRate, 0.5);
    assert.ok(Math.abs(s.reduce((a, r) => a + r.costUsd, 0) - 0.0101) < 1e-9);
    t.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken database never throws into the request path, but the failure is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "ltr-"));
  try {
    const errors: Error[] = [];
    const t = createTelemetry(join(dir, "calls.db"), { onError: (e) => errors.push(e) });
    t.close();
    assert.equal(t.record(row()), false); // closed DB: no exception
    assert.equal(errors.length, 1, "the failure is surfaced, not swallowed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost uses separate input, cached-input and output prices", () => {
  const prices: PriceTable = { "m": { input: 3, cachedInput: 0.3, output: 15 } };
  // 1M prompt tokens of which 400k cached, 100k output
  const c = costUsd("m", { prompt: 1_000_000, cached: 400_000, completion: 100_000 }, prices);
  assert.ok(Math.abs(c! - (0.6 * 3 + 0.4 * 0.3 + 0.1 * 15)) < 1e-9);
});

test("an unpriced model returns null, never a silent zero", () => {
  assert.equal(costUsd("unknown", { prompt: 10, cached: 0, completion: 10 }, {}), null);
});

test("local models are free when priced at zero", () => {
  assert.equal(costUsd("ollama/qwen2.5:7b", { prompt: 500, cached: 0, completion: 50 }, { "ollama/qwen2.5:7b": { input: 0, output: 0 } }), 0);
});
