// claude-cli provider: runs a Claude subscription headless (`claude -p`). It must report the same
// usage shape as the API providers, and remove the CLI's fixed preamble so costs match the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callProvider, type ProviderEnv } from "../src/providers.js";
import { isRetryable } from "../src/errors.js";

const cliJson = (over: Record<string, unknown> = {}): string => JSON.stringify({
  type: "result", is_error: false, result: "ANSWER: 391",
  usage: { input_tokens: 2, cache_creation_input_tokens: 1064, cache_read_input_tokens: 0, output_tokens: 96 },
  ...over,
});

function env(run: ProviderEnv["claudeCliRun"], overhead = 0): ProviderEnv {
  return { ollamaUrl: "http://localhost:11434", localContextTokens: 4096, claudeCliRun: run, claudeCliOverheadTokens: overhead };
}

test("system prompt goes to --system-prompt, the request to stdin, and tools are switched off", async () => {
  let seen: { args: string[]; stdin: string } | undefined;
  const c = await callProvider("claude-cli/claude-haiku-5-5",
    [{ role: "system", content: "be brief" }, { role: "user", content: "17 x 23?" }], 100,
    env(async (args, stdin) => { seen = { args, stdin }; return cliJson(); }));
  assert.equal(c.text, "ANSWER: 391");
  assert.equal(seen!.stdin, "17 x 23?");
  assert.equal(seen!.args[seen!.args.indexOf("--system-prompt") + 1], "be brief");
  assert.equal(seen!.args[seen!.args.indexOf("--model") + 1], "claude-haiku-5-5");
  assert.equal(seen!.args[seen!.args.indexOf("--tools") + 1], "");
});

test("usage counts every prompt token and subtracts the measured CLI preamble", async () => {
  const raw = await callProvider("claude-cli/claude-haiku-5-5", [{ role: "user", content: "q" }], 100, env(async () => cliJson()));
  assert.deepEqual(raw.usage, { prompt: 1066, cached: 0, completion: 96 });
  const adjusted = await callProvider("claude-cli/claude-haiku-5-5", [{ role: "user", content: "q" }], 100, env(async () => cliJson(), 1040));
  assert.deepEqual(adjusted.usage, { prompt: 26, cached: 0, completion: 96 });
});

test("a CLI error result is a retryable provider failure, so the chain moves on", async () => {
  await assert.rejects(
    callProvider("claude-cli/claude-sonnet-5-5", [{ role: "user", content: "q" }], 100,
      env(async () => cliJson({ is_error: true, result: "Claude usage limit reached" }))),
    (e: unknown) => isRetryable(e) && /usage limit/.test((e as Error).message),
  );
});

test("output that is not JSON fails loudly instead of being returned as an answer", async () => {
  await assert.rejects(
    callProvider("claude-cli/claude-sonnet-5-5", [{ role: "user", content: "q" }], 100, env(async () => "Not logged in")),
    /unreadable output/,
  );
});
