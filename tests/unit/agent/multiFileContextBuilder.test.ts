import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMultiFileReadPlan,
  buildMultiFileTextContext,
} from "../../../src/agent/multiFileContextBuilder.js";
import type { SourceFileSelection } from "../../../src/types/index.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-multi-file-"));
}

function select(relativePath: string): SourceFileSelection {
  return {
    path: relativePath,
    name: path.basename(relativePath),
    kind: "text",
    extension: path.extname(relativePath).toLowerCase() as SourceFileSelection["extension"],
  };
}

test("buildMultiFileReadPlan applies max file limit", () => {
  const plan = buildMultiFileReadPlan(
    [select("a.md"), select("b.txt"), select("c.csv")],
    { maxFiles: 2 },
  );

  assert.equal(plan.estimatedFileCount, 2);
  assert.deepEqual(
    plan.files.map((file) => file.path),
    ["a.md", "b.txt"],
  );
});

test("buildMultiFileTextContext reads supported text files", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "notes.md"), "# Notes\nTODO: follow up", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "data.csv"), "name,value\nA,1", "utf8");

  const result = await buildMultiFileTextContext({
    workspaceRoot,
    selectedFiles: [select("notes.md"), select("data.csv")],
    userInstruction: "summarize these",
    limits: { maxFiles: 5, maxCharsPerFile: 100, maxTotalChars: 1_000 },
  });

  assert.equal(result.files.length, 2);
  assert.equal(result.files[0]?.status, "included");
  assert.equal(result.files[1]?.status, "included");
  assert.equal(result.perFileSummaries[0]?.title, "Notes");
  assert.deepEqual(result.perFileSummaries[0]?.todos, ["TODO: follow up"]);
  assert.equal(result.combinedSummary?.sources.length, 2);
});

test("buildMultiFileTextContext records unsupported and unsafe files without reading them", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "image.png"), "fake", "utf8");

  const result = await buildMultiFileTextContext({
    workspaceRoot,
    selectedFiles: [select("image.png"), select("../outside.md")],
    userInstruction: "read selected files",
    limits: { maxFiles: 5, maxCharsPerFile: 100, maxTotalChars: 1_000 },
  });

  assert.equal(result.files[0]?.status, "unsupported");
  assert.equal(result.files[0]?.skipReason, "unsupported_type");
  assert.equal(result.files[1]?.status, "skipped");
  assert.equal(result.files[1]?.skipReason, "outside_workspace");
});

test("buildMultiFileTextContext enforces max file count", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "a.md"), "A", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "b.md"), "B", "utf8");

  const result = await buildMultiFileTextContext({
    workspaceRoot,
    selectedFiles: [select("a.md"), select("b.md")],
    userInstruction: "read selected files",
    limits: { maxFiles: 1, maxCharsPerFile: 100, maxTotalChars: 1_000 },
  });

  assert.equal(result.files[0]?.status, "included");
  assert.equal(result.files[1]?.status, "skipped");
  assert.equal(result.files[1]?.skipReason, "too_many_files");
});

test("buildMultiFileTextContext enforces per-file and total character limits", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "large.md"), "abcdef", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "second.md"), "second", "utf8");

  const result = await buildMultiFileTextContext({
    workspaceRoot,
    selectedFiles: [select("large.md"), select("second.md")],
    userInstruction: "read selected files",
    limits: { maxFiles: 5, maxCharsPerFile: 3, maxTotalChars: 3 },
  });

  assert.equal(result.files[0]?.status, "truncated");
  assert.equal(result.files[0]?.content, "abc");
  assert.equal(result.files[1]?.status, "skipped");
  assert.equal(result.files[1]?.skipReason, "too_large");
  assert.equal(result.combinedSummary?.warnings.includes("File content was truncated by the configured limits."), true);
});

test("buildMultiFileTextContext records empty files", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "empty.txt"), "   \n", "utf8");

  const result = await buildMultiFileTextContext({
    workspaceRoot,
    selectedFiles: [select("empty.txt")],
    userInstruction: "read selected files",
    limits: { maxFiles: 5, maxCharsPerFile: 100, maxTotalChars: 1_000 },
  });

  assert.equal(result.files[0]?.status, "skipped");
  assert.equal(result.files[0]?.skipReason, "empty_file");
  assert.equal(result.perFileSummaries[0]?.summary, "empty.txt is empty.");
});
