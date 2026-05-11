/**
 * Tests for the No-LLM local action draft router (TASK-040 / Workbench v2 §36).
 *
 * Acceptance rules from the handoff:
 *   - "memo.txt作って"        → matched create_file
 *   - "メモ.md作って"         → matched create_file
 *   - "backupフォルダ作って"  → matched create_folder
 *   - "フォルダ作って"        → clarify (not "new-folder")
 *   - "メモテキスト作って"    → clarify (no silent .txt guess)
 */
import assert from "node:assert/strict";
import test from "node:test";

import { tryBuildLocalActionPlan } from "../../../src/agent/localActionDraft.js";

test("matches memo.txt作って as a create_file plan", () => {
  const result = tryBuildLocalActionPlan("memo.txt作って");
  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") return;
  assert.equal(result.actionPlan.actions.length, 1);
  const action = result.actionPlan.actions[0]!;
  assert.equal(action.type, "create_file");
  if (action.type !== "create_file") return;
  assert.equal(action.path, "memo.txt");
});

test("matches メモ.md作って as a create_file plan with empty markdown body", () => {
  const result = tryBuildLocalActionPlan("メモ.md作って");
  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") return;
  const action = result.actionPlan.actions[0]!;
  assert.equal(action.type, "create_file");
  if (action.type !== "create_file") return;
  assert.equal(action.path, "メモ.md");
  assert.match(action.content, /^# メモ/);
});

test("matches backupフォルダ作って as a create_folder plan", () => {
  const result = tryBuildLocalActionPlan("backupフォルダ作って");
  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") return;
  const action = result.actionPlan.actions[0]!;
  assert.equal(action.type, "create_folder");
  if (action.type !== "create_folder") return;
  assert.equal(action.path, "backup");
});

test("clarifies フォルダ作って — never silently picks 'new-folder'", () => {
  const result = tryBuildLocalActionPlan("フォルダ作って");
  assert.equal(result.kind, "clarify");
  if (result.kind !== "clarify") return;
  assert.ok(result.chips.length > 0);
  for (const chip of result.chips) {
    assert.notEqual(chip.label, "new-folder");
  }
});

test("clarifies メモテキスト作って — never silently picks .txt", () => {
  const result = tryBuildLocalActionPlan("メモテキスト作って");
  assert.equal(result.kind, "clarify");
  if (result.kind !== "clarify") return;
  // The clarify chips must include a real format choice.
  const labels = result.chips.map((c) => c.label);
  assert.ok(labels.some((l) => l.includes(".txt")));
  assert.ok(labels.some((l) => l.includes(".md")));
});

test("returns unmatched for non-file inputs", () => {
  for (const input of ["こんにちは", "今日の予定教えて", "ありがとう"]) {
    const result = tryBuildLocalActionPlan(input);
    assert.equal(result.kind, "unmatched", `expected unmatched for: ${input}`);
  }
});

test("English: 'create folder demo' matches create_folder", () => {
  const result = tryBuildLocalActionPlan("create folder demo");
  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") return;
  const action = result.actionPlan.actions[0]!;
  assert.equal(action.type, "create_folder");
  if (action.type !== "create_folder") return;
  assert.equal(action.path, "demo");
});

// ---------------------------------------------------------------------------
// TASK-041 — broader explicit-filename coverage. These prove that any
// `xxx.<ext>作って` is handled without Ollama, regardless of leading nouns.
// ---------------------------------------------------------------------------

const NEW_FILE_CASES: Array<[string, string]> = [
  ["test.txt作って",  "test.txt"],
  ["todo.md作って",   "todo.md"],
  ["notes.json作って","notes.json"],
  ["data.csv作って",  "data.csv"],
  ["app.log作って",   "app.log"],
  ["config.yaml作って","config.yaml"],
  ["config.yml作って", "config.yml"],
];

for (const [input, expectedPath] of NEW_FILE_CASES) {
  test(`TASK-041: ${input} → matched create_file ${expectedPath}`, () => {
    const result = tryBuildLocalActionPlan(input);
    assert.equal(result.kind, "matched");
    if (result.kind !== "matched") return;
    const action = result.actionPlan.actions[0]!;
    assert.equal(action.type, "create_file");
    if (action.type !== "create_file") return;
    assert.equal(action.path, expectedPath);
  });
}

test("TASK-041: フォルダ作って still clarifies (does not invent a name)", () => {
  const result = tryBuildLocalActionPlan("フォルダ作って");
  assert.equal(result.kind, "clarify");
});

test("TASK-041: メモテキスト作って still clarifies (does not silently pick .txt)", () => {
  const result = tryBuildLocalActionPlan("メモテキスト作って");
  assert.equal(result.kind, "clarify");
});
