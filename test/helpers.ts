// Fetch mock shared by the tests. Every request URL is recorded, so a test can prove
// which providers were (and were not) contacted.
export type Reply =
  | { status?: number; body: unknown }
  | Error;

export interface FetchLog { url: string; body: unknown }

const realFetch = globalThis.fetch;

/** Route requests by URL substring to a canned reply. Unmatched URLs fail loudly. */
export function mockFetch(routes: Record<string, Reply | Reply[]>): FetchLog[] {
  const log: FetchLog[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    log.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = [...queues.keys()].find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch to ${url}`);
    const queue = queues.get(key)!;
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return log;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** OpenAI-style chat completion body (Ollama, OpenRouter, Groq all answer in this shape). */
export function openaiReply(content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }): { body: unknown } {
  return { body: { choices: [{ message: { role: "assistant", content } }], usage } };
}

export function anthropicReply(text: string): { body: unknown } {
  return {
    body: {
      content: [{ type: "text", text }],
      usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 4 },
    },
  };
}
