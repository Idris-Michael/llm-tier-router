// Code-only graders. Every task asks for a last line "ANSWER: <answer>"; a reply without it fails.
import type { Task } from "./tasks.js";

/** The text after the last "ANSWER:" marker, with markdown emphasis removed. */
export function extractAnswer(reply: string): string | null {
  const matches = [...reply.matchAll(/answer\s*:\s*([\s\S]+?)(?=\n\s*answer\s*:|$)/gi)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;
  return last.replace(/\*\*|__/g, "").replace(/^`+|`+$/g, "").trim();
}

const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").replace(/[.\s]+$/, "").trim();

function parseNumber(s: string): number | null {
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseJson(s: string): unknown {
  // Take the outermost object, whatever fence or label surrounds it.
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end < start) return undefined;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function grade(task: Pick<Task, "grader" | "expected">, reply: string): boolean {
  const answer = extractAnswer(reply);
  if (answer === null) return false;
  switch (task.grader) {
    case "number": {
      const n = parseNumber(answer);
      return n !== null && Math.abs(n - Number(task.expected)) < 1e-6;
    }
    case "json":
      return sameJson(parseJson(answer), JSON.parse(task.expected));
    case "exact":
      return normalise(answer) === normalise(task.expected);
  }
}
