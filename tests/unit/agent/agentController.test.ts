import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { planAction } from "../../../src/agent/agentController.js";
import type { FileNode, Workspace } from "../../../src/types/index.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const WORKSPACE: Workspace = {
  rootPath: "/tmp/test-workspace",
  displayName: "test-workspace",
};

const SAMPLE_FILE_TREE: FileNode[] = [
  {
    name: "docs",
    path: "docs",
    type: "directory",
    children: [
      {
        name: "readme.md",
        path: "docs/readme.md",
        type: "file",
        extension: ".md",
        size: 512,
        modifiedAt: "2024-01-01T00:00:00Z",
      },
    ],
  },
  {
    name: "notes.txt",
    path: "notes.txt",
    type: "file",
    extension: ".txt",
    size: 128,
    modifiedAt: "2024-01-02T00:00:00Z",
  },
];

const VALID_ACTION_PLAN_JSON = JSON.stringify({
  summary: "docsフォルダを整理します",
  actions: [
    {
      id: "action-1",
      type: "create_folder",
      description: "archiveフォルダを作成します",
      path: "archive",
    },
  ],
});

async function createReadableWorkspace(): Promise<Workspace> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "melunai-agent-controller-"));
  await fs.mkdir(path.join(rootPath, "docs"), { recursive: true });
  await fs.writeFile(path.join(rootPath, "docs", "readme.md"), "# readme", "utf8");
  await fs.writeFile(path.join(rootPath, "notes.txt"), "notes", "utf8");
  return { rootPath, displayName: "tmp" };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  (globalThis as Record<string, unknown>)["fetch"] = impl;
}

/**
 * Patches the listFolder function used by agentController.
 * Since we cannot easily mock ES module imports in Node's test runner,
 * we use the real listFolder but with a temp workspace that exists.
 * For failure cases, we use a non-existent path.
 *
 * For the success path we point the workspace at an actual temp dir
 * that we populate, or we use a known-existing path for CI.
 */

// ---------------------------------------------------------------------------
// Tests that do not require real filesystem (failure cases)
// ---------------------------------------------------------------------------

test("planAction returns workspace_unreadable when workspace does not exist", async () => {
  const result = await planAction({
    userInstruction: "フォルダを整理してください",
    workspace: { rootPath: "/nonexistent/path/that/does/not/exist", displayName: "missing" },
    model: "llama3:latest",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "workspace_unreadable");
    assert.ok(result.error.userMessage.length > 0);
  }
});

test("planAction returns ollama_unavailable when Ollama is not running", async () => {
  mockFetch(() => Promise.reject(new TypeError("fetch failed")));

  // Use a real path that exists so listFolder succeeds
  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_unavailable");
    assert.ok(result.error.userMessage.includes("Ollama"));
  }
});

test("planAction returns ollama_timeout on abort", async () => {
  mockFetch(() =>
    Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
  );

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
    ollamaConfig: { timeoutMs: 1 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_timeout");
    assert.equal(result.error.code, "ollama_timeout");
  }
});

test("planAction returns ollama_model_not_found on 404", async () => {
  mockFetch(async () => new Response("model not found", { status: 404 }));

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "nonexistent:latest",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_model_not_found");
    assert.ok(result.error.userMessage.length > 0);
  }
});

test("planAction returns ollama_error on 500", async () => {
  mockFetch(async () => new Response("Internal Server Error", { status: 500 }));

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_error");
  }
});

test("planAction returns parse_failed when LLM returns invalid JSON", async () => {
  mockFetch(async () =>
    makeJsonResponse({
      model: "llama3:latest",
      message: { role: "assistant", content: "これはJSONではありません" },
      done: true,
    }),
  );

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "parse_failed");
    assert.ok(result.error.userMessage.length > 0);
  }
});

test("planAction returns parse_failed when LLM returns unknown action type", async () => {
  const badPlan = JSON.stringify({
    summary: "危険な操作",
    actions: [
      {
        id: "action-1",
        type: "delete_file",
        description: "ファイルを削除する",
        path: "secret.txt",
      },
    ],
  });

  mockFetch(async () =>
    makeJsonResponse({
      model: "llama3:latest",
      message: { role: "assistant", content: badPlan },
      done: true,
    }),
  );

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  // delete_file is rejected by the parser as unknown_action_type
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "parse_failed");
  }
});

test("planAction returns ok with validationResult when plan is valid", async () => {
  mockFetch(async () =>
    makeJsonResponse({
      model: "llama3:latest",
      message: { role: "assistant", content: VALID_ACTION_PLAN_JSON },
      done: true,
    }),
  );

  const result = await planAction({
    userInstruction: "archiveフォルダを作ってください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.actionPlan.actions.length, 1);
    assert.equal(result.actionPlan.actions[0]?.type, "create_folder");
    assert.ok(typeof result.validationResult.executable === "boolean");
    assert.ok(Array.isArray(result.validationResult.issues));
  }
});

test("planAction never returns an executable plan when action has absolute path", async () => {
  const unsafePlan = JSON.stringify({
    summary: "危険な操作",
    actions: [
      {
        id: "action-1",
        type: "create_folder",
        description: "絶対パスを使用",
        path: "/etc/evil",
      },
    ],
  });

  mockFetch(async () =>
    makeJsonResponse({
      model: "llama3:latest",
      message: { role: "assistant", content: unsafePlan },
      done: true,
    }),
  );

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.validationResult.executable, false);
    assert.ok(result.validationResult.issues.some((issue) => issue.level === "blocked"));
  }
});

test("planAction passes filePreviews into context without reading files itself", async () => {
  let capturedUserMessage = "";

  mockFetch(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { messages: Array<{ role: string; content: string }> };
    const userMsg = body.messages.find((m) => m.role === "user");
    capturedUserMessage = userMsg?.content ?? "";

    return makeJsonResponse({
      model: "llama3:latest",
      message: { role: "assistant", content: VALID_ACTION_PLAN_JSON },
      done: true,
    });
  });

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
    filePreviews: [
      { path: "notes.txt", content: "重要なメモがあります", truncated: false },
    ],
  });

  assert.ok(result.ok);
  assert.ok(capturedUserMessage.includes("重要なメモがあります"));
});

test("planAction sends system message and user message to Ollama", async () => {
  let capturedMessages: Array<{ role: string; content: string }> = [];

  mockFetch(async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { messages: Array<{ role: string; content: string }> };
    capturedMessages = body.messages;

    return makeJsonResponse({
      model: "llama3:latest",
      message: { role: "assistant", content: VALID_ACTION_PLAN_JSON },
      done: true,
    });
  });

  await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  assert.equal(capturedMessages.length, 2);
  assert.equal(capturedMessages[0]?.role, "system");
  assert.equal(capturedMessages[1]?.role, "user");
});

test("planAction does not execute actions - returns plan only", async () => {
  mockFetch(async () =>
    makeJsonResponse({
      model: "llama3:latest",
      message: { role: "assistant", content: VALID_ACTION_PLAN_JSON },
      done: true,
    }),
  );

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  // Result contains plan and validation, never execution output
  if (result.ok) {
    assert.ok("actionPlan" in result);
    assert.ok("validationResult" in result);
    assert.ok(!("executionResult" in result));
  }
});

test("planAction user-facing error messages are in Japanese", async () => {
  mockFetch(() => Promise.reject(new TypeError("fetch failed")));

  const result = await planAction({
    userInstruction: "整理してください",
    workspace: await createReadableWorkspace(),
    model: "llama3:latest",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    // userMessage should contain Japanese characters
    assert.ok(/[ぁ-んァ-ン一-龯]/.test(result.error.userMessage));
  }
});

