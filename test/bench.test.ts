// Benchmark tests: a grader that is too strict or too loose would make the headline number
// wrong, and a puzzle with two valid answers would punish a correct model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnswer, grade } from "../bench/graders.js";
import { buildTasks, solveOrdering, type Task } from "../bench/tasks.js";

test("the final ANSWER line is used, not earlier working", () => {
  assert.equal(extractAnswer("First I thought 12.\nThen 14.\nANSWER: 18"), "18");
  assert.equal(extractAnswer("answer: **42**"), "42");
  assert.equal(extractAnswer("no marker here"), null);
});

test("number grading ignores commas, currency and trailing units but not wrong values", () => {
  const t = { grader: "number", expected: "1200" } as Task;
  assert.equal(grade(t, "ANSWER: $1,200"), true);
  assert.equal(grade(t, "ANSWER: 1200.00 dollars"), true);
  assert.equal(grade(t, "ANSWER: 120"), false);
  assert.equal(grade(t, "The total is 1200"), false, "a reply without the ANSWER line fails");
});

test("json grading compares structure, not formatting", () => {
  const t = { grader: "json", expected: JSON.stringify({ name: "Ana", age: 31 }) } as Task;
  assert.equal(grade(t, 'ANSWER: {"age": 31, "name": "Ana"}'), true);
  assert.equal(grade(t, 'ANSWER: ```json\n{"name":"Ana","age":31}\n```'), true);
  assert.equal(grade(t, 'ANSWER: {"name":"Ana","age":"31"}'), false, "a string where a number belongs is wrong");
});

test("exact grading is case- and space-insensitive only", () => {
  const t = { grader: "exact", expected: "Bea, Cal, Ana" } as Task;
  assert.equal(grade(t, "ANSWER: bea,cal,ana"), true);
  assert.equal(grade(t, "ANSWER: Cal, Bea, Ana"), false);
});

test("every generated ordering puzzle has exactly one solution, and it is the expected answer", () => {
  const puzzles = buildTasks({ seed: 7 }).filter((t) => t.kind === "ordering");
  assert.ok(puzzles.length >= 15);
  for (const p of puzzles) {
    const solutions = solveOrdering(p.meta!.names as string[], p.meta!.constraints as never);
    assert.equal(solutions.length, 1, p.id);
    assert.equal(solutions[0]!.join(", "), p.expected, p.id);
  }
});

test("the task set is deterministic for a seed and spans every kind", () => {
  const a = buildTasks({ seed: 7 });
  const b = buildTasks({ seed: 7 });
  assert.deepEqual(a.map((t) => t.prompt), b.map((t) => t.prompt));
  assert.deepEqual(new Set(a.map((t) => t.kind)), new Set(["extract", "arithmetic", "json", "date", "gsm8k", "ordering"]));
  assert.ok(a.length >= 110 && a.length <= 140, `got ${a.length}`);
  assert.equal(new Set(a.map((t) => t.id)).size, a.length, "ids are unique");
});
