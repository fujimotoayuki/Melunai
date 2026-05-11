import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createJsonlLogger,
  writeJsonlEvent,
  type LoggedEvent,
} from "../../../src/storage/index.js";
import type { ActionPlan, ValidationResult } from "../../../src/types/index.js";

async function createTempLogPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-file-agent-logs-"));
  return path.join(dir, "events.jsonl");
}

async function readJsonl(logFilePath: string): Promise<LoggedEvent[]> {
  const content = await fs.readFile(logFilePath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent);
}

test("writeJsonlEvent logs user instructions as one JSON line", async () => {
  const logFilePath = await createTempLogPath();

  const result = await writeJsonlEvent(
    logFilePath,
    {
      type: "user_instruction",
      sessionId: "session-1",
      workspaceRoot: "C:/workspace",
      userInstruction: "docsを整理してください",
    },
    { now: () => new Date("2026-04-28T00:00:00.000Z") },
  );

  assert.equal(result.ok, true);
  const [event] = await readJsonl(logFilePath);
  assert.equal(event?.type, "user_instruction");
  assert.equal(event?.timestamp, "2026-04-28T00:00:00.000Z");
  assert.equal(event?.sessionId, "session-1");
  assert.equal(event?.workspaceRoot, "C:/workspace");
  assert.equal(
    event?.type === "user_instruction" ? event.userInstruction : undefined,
    "docsを整理してください",
  );
});

test("createJsonlLogger appends multiple structured events", async () => {
  const logFilePath = await createTempLogPath();
  const logger = createJsonlLogger(logFilePath, {
    now: () => new Date("2026-04-28T01:02:03.000Z"),
  });

  const first = await logger.log({ type: "model_selected", model: "llama3:latest" });
  const second = await logger.log({
    type: "error",
    error: { code: "ollama_unavailable", message: "Ollama unavailable" },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const events = await readJsonl(logFilePath);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "model_selected");
  assert.equal(events[1]?.type, "error");
});

test("writeJsonlEvent logs ActionPlan and ValidationResult payloads", async () => {
  const logFilePath = await createTempLogPath();
  const actionPlan: ActionPlan = {
    summary: "archiveフォルダを作成します",
    actions: [
      {
        id: "action-1",
        type: "create_folder",
        description: "archiveを作成します",
        path: "archive",
      },
    ],
  };
  const validationResult: ValidationResult = {
    executable: true,
    issues: [],
    validatedActions: actionPlan.actions,
  };

  await writeJsonlEvent(logFilePath, { type: "action_plan", actionPlan });
  await writeJsonlEvent(logFilePath, { type: "validation_result", validationResult });

  const events = await readJsonl(logFilePath);
  const actionPlanEvent = events[0];
  const validationResultEvent = events[1];
  assert.equal(actionPlanEvent?.type, "action_plan");
  assert.deepEqual(
    actionPlanEvent?.type === "action_plan" ? actionPlanEvent.actionPlan : undefined,
    actionPlan,
  );
  assert.equal(validationResultEvent?.type, "validation_result");
  assert.deepEqual(
    validationResultEvent?.type === "validation_result"
      ? validationResultEvent.validationResult
      : undefined,
    validationResult,
  );
});

test("writeJsonlEvent logs execution results", async () => {
  const logFilePath = await createTempLogPath();
  const executionResult = {
    attempted: ["action-1"],
    succeeded: ["action-1"],
    failed: [],
    skipped: [],
  };

  await writeJsonlEvent(logFilePath, {
    type: "execution_result",
    executionResult,
  });

  const [event] = await readJsonl(logFilePath);
  assert.equal(event?.type, "execution_result");
  assert.deepEqual(
    event?.type === "execution_result" ? event.executionResult : undefined,
    executionResult,
  );
});

test("writeJsonlEvent creates missing parent directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-file-agent-logs-"));
  const logFilePath = path.join(root, "nested", "events.jsonl");

  const result = await writeJsonlEvent(logFilePath, {
    type: "model_selected",
    model: "llama3:latest",
  });

  assert.equal(result.ok, true);
  assert.equal((await readJsonl(logFilePath)).length, 1);
});

test("writeJsonlEvent returns ToolResult error when writing fails", async () => {
  const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "local-file-agent-logs-"));

  const result = await writeJsonlEvent(directoryPath, {
    type: "model_selected",
    model: "llama3:latest",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "log_write_failed");
    assert.equal(typeof result.error.message, "string");
    assert.ok(result.error.cause);
  }
});

test("writeJsonlEvent serializes Error, BigInt, and circular causes safely", async () => {
  const logFilePath = await createTempLogPath();
  const circular: Record<string, unknown> = {
    reason: new Error("disk full"),
    amount: 10n,
  };
  circular.self = circular;

  const result = await writeJsonlEvent(logFilePath, {
    type: "error",
    error: {
      code: "disk_error",
      message: "Disk error",
      cause: circular,
    },
  });

  assert.equal(result.ok, true);
  const [event] = await readJsonl(logFilePath);
  assert.equal(event?.type, "error");
  if (event?.type === "error") {
    const cause = event.error.cause as Record<string, unknown>;
    const reason = cause.reason as Record<string, unknown>;
    assert.equal(reason.name, "Error");
    assert.equal(reason.message, "disk full");
    assert.equal(typeof reason.stack, "string");
    assert.equal(cause.amount, "10");
    assert.equal(cause.self, "[Circular]");
  }
});
