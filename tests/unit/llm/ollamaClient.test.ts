import assert from "node:assert/strict";
import test from "node:test";

import { chat, listModels } from "../../../src/llm/ollamaClient.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: FetchMock): void {
  (globalThis as Record<string, unknown>)["fetch"] = impl;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeTextResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function makeNetworkError(): Promise<Response> {
  return Promise.reject(new TypeError("fetch failed"));
}

function makeAbortError(): Promise<Response> {
  const error = new DOMException("The operation was aborted.", "AbortError");
  return Promise.reject(error);
}

const VALID_TAGS_BODY = {
  models: [
    {
      name: "llama3:latest",
      modified_at: "2024-01-01T00:00:00Z",
      size: 4_000_000_000,
      digest: "sha256:abc123",
    },
    {
      name: "mistral:latest",
      modified_at: "2024-01-02T00:00:00Z",
      size: 3_000_000_000,
      digest: "sha256:def456",
    },
  ],
};

const VALID_CHAT_RESPONSE = {
  model: "llama3:latest",
  created_at: "2024-01-01T00:00:00Z",
  message: {
    role: "assistant",
    content: "Here is your plan.",
  },
  done: true,
};

// ---------------------------------------------------------------------------
// listModels tests
// ---------------------------------------------------------------------------

test("listModels returns available models", async () => {
  mockFetch(async () => makeJsonResponse(VALID_TAGS_BODY));

  const result = await listModels();

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0]?.name, "llama3:latest");
    assert.equal(result.data[1]?.name, "mistral:latest");
  }
});

test("listModels returns empty array when no models are installed", async () => {
  mockFetch(async () => makeJsonResponse({ models: [] }));

  const result = await listModels();

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.length, 0);
  }
});

test("listModels returns ollama_unavailable when Ollama is not running", async () => {
  mockFetch(() => makeNetworkError());

  const result = await listModels();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_unavailable");
  }
});

test("listModels returns ollama_timeout when request exceeds timeout", async () => {
  mockFetch(() => makeAbortError());

  const result = await listModels({ timeoutMs: 1 });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_timeout");
  }
});

test("listModels returns ollama_error on non-200 response", async () => {
  mockFetch(async () => makeTextResponse("Internal Server Error", 500));

  const result = await listModels();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_error");
  }
});

test("listModels returns ollama_invalid_response on malformed JSON", async () => {
  mockFetch(async () => new Response("not json", { status: 200 }));

  const result = await listModels();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_invalid_response");
  }
});

test("listModels returns ollama_invalid_response on unexpected response shape", async () => {
  mockFetch(async () => makeJsonResponse({ unexpected: true }));

  const result = await listModels();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_invalid_response");
  }
});

test("listModels uses configurable endpoint", async () => {
  let capturedUrl = "";
  mockFetch(async (url) => {
    capturedUrl = url.toString();
    return makeJsonResponse(VALID_TAGS_BODY);
  });

  await listModels({ endpoint: "http://localhost:9999" });

  assert.ok(capturedUrl.startsWith("http://localhost:9999"));
});

test("listModels does not fall back to cloud LLM", async () => {
  let callCount = 0;
  mockFetch(async (url) => {
    callCount += 1;
    const urlStr = url.toString();
    assert.ok(
      urlStr.includes("localhost") || urlStr.includes("127.0.0.1"),
      `Expected local URL but got: ${urlStr}`,
    );
    return makeJsonResponse(VALID_TAGS_BODY);
  });

  await listModels();

  assert.equal(callCount, 1);
});

// ---------------------------------------------------------------------------
// chat tests
// ---------------------------------------------------------------------------

test("chat returns assistant text on success", async () => {
  mockFetch(async () => makeJsonResponse(VALID_CHAT_RESPONSE));

  const result = await chat({
    model: "llama3:latest",
    messages: [{ role: "user", content: "Organize my files." }],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data, "Here is your plan.");
  }
});

test("chat returns ollama_unavailable when Ollama is not running", async () => {
  mockFetch(() => makeNetworkError());

  const result = await chat({
    model: "llama3:latest",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_unavailable");
  }
});

test("chat returns ollama_timeout on abort", async () => {
  mockFetch(() => makeAbortError());

  const result = await chat({
    model: "llama3:latest",
    messages: [{ role: "user", content: "Hello" }],
    config: { timeoutMs: 1 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_timeout");
  }
});

test("chat returns ollama_model_not_found on 404", async () => {
  mockFetch(async () => makeTextResponse("model not found", 404));

  const result = await chat({
    model: "nonexistent:latest",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_model_not_found");
  }
});

test("chat returns ollama_error on non-200 non-404 response", async () => {
  mockFetch(async () => makeTextResponse("Internal Server Error", 500));

  const result = await chat({
    model: "llama3:latest",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_error");
  }
});

test("chat returns ollama_invalid_response on malformed JSON", async () => {
  mockFetch(async () => new Response("not json", { status: 200 }));

  const result = await chat({
    model: "llama3:latest",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_invalid_response");
  }
});

test("chat returns ollama_invalid_response on unexpected response shape", async () => {
  mockFetch(async () => makeJsonResponse({ unexpected: true }));

  const result = await chat({
    model: "llama3:latest",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "ollama_invalid_response");
  }
});

test("chat sends system and user messages correctly", async () => {
  let capturedBody: Record<string, unknown> = {};
  mockFetch(async (_url, init) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeJsonResponse(VALID_CHAT_RESPONSE);
  });

  await chat({
    model: "llama3:latest",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Organize my files." },
    ],
  });

  const messages = capturedBody["messages"] as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");
  assert.equal(capturedBody["stream"], false);
});

test("chat does not fall back to cloud LLM", async () => {
  mockFetch(async (url) => {
    const urlStr = url.toString();
    assert.ok(
      urlStr.includes("localhost") || urlStr.includes("127.0.0.1"),
      `Expected local URL but got: ${urlStr}`,
    );
    return makeJsonResponse(VALID_CHAT_RESPONSE);
  });

  await chat({
    model: "llama3:latest",
    messages: [{ role: "user", content: "Hello" }],
  });
});

test("chat uses configurable endpoint", async () => {
  let capturedUrl = "";
  mockFetch(async (url) => {
    capturedUrl = url.toString();
    return makeJsonResponse(VALID_CHAT_RESPONSE);
  });

  await chat({
    model: "llama3:latest",
    messages: [{ role: "user", content: "Hello" }],
    config: { endpoint: "http://localhost:9999" },
  });

  assert.ok(capturedUrl.startsWith("http://localhost:9999"));
});
