// The benchmark task set: public GSM8K problems plus seeded generated tasks, all graded in code.
// Kinds run from trivial (extract an email) to hard (5-person ordering puzzles), so a router
// has something to tell apart. No model-written code is ever executed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Grader = "number" | "json" | "exact";
export type Kind = "extract" | "arithmetic" | "json" | "date" | "gsm8k" | "ordering";

export interface Task {
  id: string;
  kind: Kind;
  prompt: string;
  expected: string;
  grader: Grader;
  meta?: Record<string, unknown>;
}

export const SYSTEM_PROMPT = "Solve the task. You may think step by step, but end your reply with one final line in the form: ANSWER: <answer>";

/** mulberry32: small, seedable, good enough for picking test data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ana", "Bea", "Cal", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jon", "Kai", "Lea", "Max", "Nia", "Oto"];
const CITIES = ["Leeds", "Porto", "Lagos", "Osaka", "Quito", "Perth", "Turin", "Accra"];
const DOMAINS = ["example.org", "mail.test", "corp.example", "studio.example"];

function extractTasks(r: () => number, pick: <T>(xs: T[]) => T): Task[] {
  return Array.from({ length: 15 }, (_, i) => {
    const name = pick(FIRST);
    const email = `${name.toLowerCase()}.${Math.floor(r() * 900 + 100)}@${pick(DOMAINS)}`;
    const text = `Hi team, ${name} here from the ${pick(CITIES)} office. Please send the signed form to ${email} by Friday; my old address no longer works. Thanks!`;
    return { id: `extract-${i}`, kind: "extract" as const, prompt: `Extract the email address from this message.\n\n${text}`, expected: email, grader: "exact" as const };
  });
}

function arithmeticTasks(r: () => number): Task[] {
  return Array.from({ length: 10 }, (_, i) => {
    const a = Math.floor(r() * 90 + 10);
    const b = Math.floor(r() * 90 + 10);
    return { id: `arith-${i}`, kind: "arithmetic" as const, prompt: `What is ${a} × ${b}?`, expected: String(a * b), grader: "number" as const };
  });
}

function jsonTasks(r: () => number, pick: <T>(xs: T[]) => T): Task[] {
  return Array.from({ length: 15 }, (_, i) => {
    const rec = { name: pick(FIRST), age: Math.floor(r() * 50 + 18), city: pick(CITIES), active: r() > 0.5 };
    const line = `name: ${rec.name}; city: ${rec.city}; age: ${rec.age}; active: ${rec.active ? "yes" : "no"}`;
    return {
      id: `json-${i}`, kind: "json" as const, grader: "json" as const, expected: JSON.stringify(rec),
      prompt: `Convert this record to a JSON object with keys name (string), age (number), city (string) and active (boolean). Give the JSON on the ANSWER line.\n\n${line}`,
    };
  });
}

function dateTasks(r: () => number): Task[] {
  return Array.from({ length: 15 }, (_, i) => {
    const start = new Date(Date.UTC(2025, Math.floor(r() * 12), Math.floor(r() * 28) + 1));
    const days = Math.floor(r() * 300) + 20;
    const end = new Date(start.getTime() + days * 86_400_000);
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    return { id: `date-${i}`, kind: "date" as const, prompt: `What date is ${days} days after ${iso(start)}? Answer in YYYY-MM-DD format.`, expected: iso(end), grader: "exact" as const };
  });
}

function gsm8kTasks(): Task[] {
  const file = fileURLToPath(new URL("./tasks/gsm8k-sample.jsonl", import.meta.url));
  return readFileSync(file, "utf8").trim().split("\n").map((line) => {
    const j = JSON.parse(line) as { id: string; question: string; answer: string };
    return { id: j.id, kind: "gsm8k" as const, prompt: j.question, expected: j.answer, grader: "number" as const };
  });
}

// ─── Ordering puzzles ────────────────────────────────────────────────────────
export type Constraint =
  | { type: "pos"; a: string; pos: number }
  | { type: "notEnd"; a: string }
  | { type: "leftOf"; a: string; b: string }
  | { type: "adjacent"; a: string; b: string }
  | { type: "notAdjacent"; a: string; b: string };

function holds(c: Constraint, order: string[]): boolean {
  const at = (n: string): number => order.indexOf(n);
  switch (c.type) {
    case "pos": return at(c.a) === c.pos - 1;
    case "notEnd": return at(c.a) !== 0 && at(c.a) !== order.length - 1;
    case "leftOf": return at(c.a) < at(c.b);
    case "adjacent": return Math.abs(at(c.a) - at(c.b)) === 1;
    case "notAdjacent": return Math.abs(at(c.a) - at(c.b)) !== 1;
  }
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

export function solveOrdering(names: string[], constraints: Constraint[]): string[][] {
  return permutations(names).filter((p) => constraints.every((c) => holds(c, p)));
}

function describe(c: Constraint): string {
  switch (c.type) {
    case "pos": return `${c.a} is in position ${c.pos}.`;
    case "notEnd": return `${c.a} is not at either end.`;
    case "leftOf": return `${c.a} is somewhere to the left of ${c.b}.`;
    case "adjacent": return `${c.a} and ${c.b} stand next to each other.`;
    case "notAdjacent": return `${c.a} and ${c.b} do not stand next to each other.`;
  }
}

function orderingTasks(r: () => number, pick: <T>(xs: T[]) => T): Task[] {
  const tasks: Task[] = [];
  for (let i = 0; tasks.length < 20; i++) {
    const names = [...FIRST].sort(() => r() - 0.5).slice(0, 5);
    const answer = [...names].sort(() => r() - 0.5);
    const constraints: Constraint[] = [];
    // Add true facts (never a direct position first) until exactly one order fits.
    for (let guard = 0; guard < 60 && solveOrdering(names, constraints).length !== 1; guard++) {
      const [a, b] = [pick(names), pick(names)];
      const type = pick(["leftOf", "adjacent", "notAdjacent", "notEnd", "leftOf", "pos"] as const);
      const c: Constraint = type === "pos" ? { type, a, pos: answer.indexOf(a) + 1 } : type === "notEnd" ? { type, a } : { type, a, b };
      if ("b" in c && c.a === c.b) continue;
      if (!holds(c, answer)) continue;
      if (constraints.filter((x) => x.type === "pos").length >= 1 && c.type === "pos") continue;
      const before = solveOrdering(names, constraints).length;
      if (solveOrdering(names, [...constraints, c]).length < before) constraints.push(c);
    }
    if (solveOrdering(names, constraints).length !== 1) continue;
    tasks.push({
      id: `ordering-${tasks.length}`, kind: "ordering", grader: "exact", expected: answer.join(", "),
      prompt: `Five people, ${names.join(", ")}, stand in a line, positions 1 to 5 from left to right.\n${constraints.map(describe).join("\n")}\nGive the order from left to right as a comma-separated list of names.`,
      meta: { names, constraints },
    });
  }
  return tasks;
}

export function buildTasks({ seed = 7 }: { seed?: number } = {}): Task[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  return [
    ...extractTasks(r, pick), ...arithmeticTasks(r), ...jsonTasks(r, pick),
    ...dateTasks(r), ...gsm8kTasks(), ...orderingTasks(r, pick),
  ];
}
