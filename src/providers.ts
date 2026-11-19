// Provider adapters. A model id carries its provider as a prefix:
//   ollama/qwen2.5:7b · openrouter/deepseek/deepseek-chat · groq/llama-3.3-70b-versatile · anthropic/claude-sonnet-4-6
//   claude-cli/claude-sonnet-5-5 (a Claude subscription, run headless through `claude -p`)
// Plain fetch, no SDKs: fewer dependencies, and tests can see every request.
import { spawn } from "node:child_process";
import type { ChatMessage, Completion, Usage } from "./types.js";
import { ContextOverflowError, MissingKeyError, ProviderError } from "./errors.js";

export interface ProviderEnv {
  ollamaUrl: string;
  openrouterKey?: string;
  anthropicKey?: string;
  groqKey?: string;
  /** Ollama's num_ctx. Prompts that would not leave room for a reply are refused. */
  localContextTokens: number;
  /** Fixed preamble `claude -p` adds to every prompt, removed from reported usage so cost matches
   *  a direct API call. Measure it with `measureClaudeCliOverhead`. Default 0 (raw usage). */
  claudeCliOverheadTokens?: number;
  /** Runs the CLI; replaceable in tests. Default spawns `claude`. */
  claudeCliRun?: (args: string[], stdin: string) => Promise<string>;
}

export interface CallOptions {
  temperature?: number;
}

const MIN_LOCAL_REPLY_TOKENS = 256;
const ANTHROPIC_VERSION = "2023-06-01";

export function envFromProcess(): ProviderEnv {
  return {
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
    openrouterKey: process.env.OPENROUTER_API_KEY || undefined,
    anthropicKey: process.env.ANTHROPIC_API_KEY || undefined,
    groqKey: process.env.GROQ_API_KEY || undefined,
    localContextTokens: Number(process.env.OLLAMA_NUM_CTX ?? 4096),
  };
}

/** Rough count used only for the local-context guard: 4 characters per token. */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
}

const PROVIDERS = ["ollama", "openrouter", "groq", "anthropic", "claude-cli"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function providerOf(model: string): Provider | null {
  const prefix = model.split("/", 1)[0];
  return (PROVIDERS as readonly string[]).includes(prefix ?? "") ? (prefix as Provider) : null;
}

const stripThink = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
const withoutPrefix = (model: string): string => model.slice(model.indexOf("/") + 1);

export async function callProvider(
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  env: ProviderEnv,
  opts: CallOptions = {},
): Promise<Completion> {
  const temperature = opts.temperature ?? 0;
  switch (providerOf(model)) {
    case "ollama": {
      const room = env.localContextTokens - estimateTokens(messages);
      if (room < MIN_LOCAL_REPLY_TOKENS) {
        throw new ContextOverflowError(`local context exceeded: prompt ~${estimateTokens(messages)} tokens, num_ctx ${env.localContextTokens}`);
      }
      return openaiCompatible(model, `${env.ollamaUrl}/v1/chat/completions`, undefined, messages, Math.min(maxTokens, room), temperature);
    }
    case "openrouter":
      return openaiCompatible(model, "https://openrouter.ai/api/v1/chat/completions", requireKey(env.openrouterKey, "OPENROUTER_API_KEY"), messages, maxTokens, temperature);
    case "groq":
      return openaiCompatible(model, "https://api.groq.com/openai/v1/chat/completions", requireKey(env.groqKey, "GROQ_API_KEY"), messages, maxTokens, temperature);
    case "anthropic":
      return anthropic(model, requireKey(env.anthropicKey, "ANTHROPIC_API_KEY"), messages, maxTokens, temperature);
    case "claude-cli":
      return claudeCli(model, messages, env);
    default:
      throw new ProviderError(`unknown provider for model "${model}" (expected ollama/, openrouter/, groq/, anthropic/ or claude-cli/)`);
  }
}

function requireKey(key: string | undefined, name: string): string {
  if (!key) throw new MissingKeyError(`no API key: ${name} is not set`);
  return key;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, model: string): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { message?: string } | string }).error;
    const msg = typeof err === "string" ? err : err?.message ?? `HTTP ${res.status}`;
    // Groq's free tier answers 413 when a request is over its tokens-per-minute: a rate limit, not a bad request.
    const status = model.startsWith("groq/") && res.status === 413 ? 429 : res.status;
    throw new ProviderError(`${model}: ${msg}`, status);
  }
  return data;
}

interface OpenAIResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

async function openaiCompatible(
  model: string, url: string, key: string | undefined, messages: ChatMessage[], maxTokens: number, temperature: number,
): Promise<Completion> {
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const data = (await postJson(url, headers, { model: withoutPrefix(model), messages, max_tokens: maxTokens, temperature }, model)) as OpenAIResponse;
  const u = data.usage ?? {};
  const usage: Usage = { prompt: u.prompt_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, completion: u.completion_tokens ?? 0 };
  return { text: stripThink(data.choices?.[0]?.message?.content ?? ""), usage, model };
}

// ─── claude-cli: a Claude subscription, headless ─────────────────────────────
// Temperature and max tokens are not settable through the CLI; the model's defaults apply.
const CLI_TIMEOUT_MS = 180_000;

function spawnClaude(args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell: a shell drops empty-string arguments (`--tools ""`) and shifts every flag after them.
    const child = spawn(process.env.CLAUDE_CLI_PATH ?? "claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new ProviderError("claude-cli timed out", 504)); }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(new ProviderError(`claude-cli could not start: ${e.message}`, 503)); });
    child.on("close", () => { clearTimeout(timer); resolve(out || err); });
    child.stdin.end(stdin);
  });
}

interface CliResult {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

async function claudeCli(model: string, messages: ChatMessage[], env: ProviderEnv): Promise<Completion> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  const stdin = turns.length === 1 ? turns[0]!.content : turns.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  const args = [
    "-p", "--model", withoutPrefix(model), "--output-format", "json", "--tools", "", "--strict-mcp-config",
    "--disable-slash-commands", "--setting-sources", "", "--no-session-persistence",
    ...(system ? ["--system-prompt", system] : []),
  ];
  const raw = await (env.claudeCliRun ?? spawnClaude)(args, stdin);
  let data: CliResult;
  try {
    data = JSON.parse(raw) as CliResult;
  } catch {
    throw new ProviderError(`${model}: unreadable output from claude-cli: ${raw.slice(0, 120)}`, 502);
  }
  // Any CLI failure (usage limit, login, overload) is treated as an outage: try the next model.
  if (data.is_error) throw new ProviderError(`${model}: ${String(data.result ?? "claude-cli error").slice(0, 200)}`, 503);
  const u = data.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  const fullPrompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached;
  const overhead = env.claudeCliOverheadTokens ?? 0;
  const usage: Usage = {
    prompt: Math.max(0, fullPrompt - overhead),
    cached: Math.max(0, cached - Math.max(0, overhead - (fullPrompt - cached))),
    completion: u.output_tokens ?? 0,
  };
  return { text: stripThink(data.result ?? ""), usage, model };
}

/** Prompt tokens the CLI adds on top of the caller's own: a 1-word call's reported prompt minus
 *  that word's own tokens. Pass the result as `claudeCliOverheadTokens`. */
export async function measureClaudeCliOverhead(model: string, env: ProviderEnv): Promise<number> {
  const c = await claudeCli(model, [{ role: "system", content: "x" }, { role: "user", content: "x" }], { ...env, claudeCliOverheadTokens: 0 });
  return Math.max(0, c.usage.prompt - 2);
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

async function anthropic(model: string, key: string, messages: ChatMessage[], maxTokens: number, temperature: number): Promise<Completion> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const body = {
    model: withoutPrefix(model),
    max_tokens: maxTokens,
    temperature,
    ...(system ? { system } : {}),
    messages: messages.filter((m) => m.role !== "system"),
  };
  const data = (await postJson("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }, body, model)) as AnthropicResponse;
  const u = data.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  // Anthropic reports uncached input separately; normalise so `prompt` is the full prompt.
  const usage: Usage = { prompt: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0), cached, completion: u.output_tokens ?? 0 };
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return { text: stripThink(text), usage, model };
}
