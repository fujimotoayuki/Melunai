import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFile,
  createFolder,
  listFolder,
  moveFile,
  readFile,
  renameFile,
} from "../../../src/tools/fileTools.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "local-file-agent-tools-"));
}

test("listFolder returns files and folders", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.mkdir(path.join(workspaceRoot, "docs"));
  await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "hello", "utf8");

  const result = await listFolder(workspaceRoot);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.data.map((node) => node.name),
      ["docs", "notes.txt"],
    );
  }
});

test("readFile reads supported text files", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "notes.md"), "# Notes", "utf8");

  const result = await readFile(workspaceRoot, "notes.md");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.content, "# Notes");
    assert.equal(result.data.truncated, false);
  }
});

test("readFile reads all MVP supported text extensions", async () => {
  const workspaceRoot = await createTempWorkspace();
  const files = [
    ["notes.txt", "txt"],
    ["notes.md", "md"],
    ["data.json", "{\"ok\":true}"],
    ["table.csv", "a,b"],
  ];

  for (const [fileName, content] of files as Array<[string, string]>) {
    await fs.writeFile(path.join(workspaceRoot, fileName), content, "utf8");

    const result = await readFile(workspaceRoot, fileName);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.content, content);
    }
  }
});

test("readFile truncates large files", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "large.txt"), "abcdef", "utf8");

  const result = await readFile(workspaceRoot, "large.txt", 3);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.content, "abc");
    assert.equal(result.data.truncated, true);
  }
});

test("readFile rejects unsupported file types", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "image.png"), "fake", "utf8");

  const result = await readFile(workspaceRoot, "image.png");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "unsupported_file_type");
  }
});

test("createFolder creates a folder", async () => {
  const workspaceRoot = await createTempWorkspace();

  const result = await createFolder(workspaceRoot, "docs");

  assert.equal(result.ok, true);
  assert.equal(await fs.stat(path.join(workspaceRoot, "docs")).then((stats) => stats.isDirectory()), true);
});

test("createFile creates a file", async () => {
  const workspaceRoot = await createTempWorkspace();

  const result = await createFile(workspaceRoot, "docs/readme.md", "# Readme");

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(workspaceRoot, "docs", "readme.md"), "utf8"), "# Readme");
});

test("createFile refuses overwrite by default", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "first", "utf8");

  const result = await createFile(workspaceRoot, "notes.txt", "second");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "target_exists");
  }
  assert.equal(await fs.readFile(path.join(workspaceRoot, "notes.txt"), "utf8"), "first");
});

test("moveFile moves a file", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.mkdir(path.join(workspaceRoot, "inbox"));
  await fs.writeFile(path.join(workspaceRoot, "inbox", "file.txt"), "hello", "utf8");

  const result = await moveFile(workspaceRoot, "inbox/file.txt", "docs/file.txt");

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(workspaceRoot, "docs", "file.txt"), "utf8"), "hello");
});

test("moveFile refuses overwrite even when overwrite is requested in MVP", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.mkdir(path.join(workspaceRoot, "inbox"));
  await fs.mkdir(path.join(workspaceRoot, "docs"));
  await fs.writeFile(path.join(workspaceRoot, "inbox", "file.txt"), "source", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "docs", "file.txt"), "target", "utf8");

  const result = await moveFile(workspaceRoot, "inbox/file.txt", "docs/file.txt", true);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "overwrite_unsupported");
  }
  assert.equal(await fs.readFile(path.join(workspaceRoot, "docs", "file.txt"), "utf8"), "target");
});

test("renameFile renames a file", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "old.txt"), "hello", "utf8");

  const result = await renameFile(workspaceRoot, "old.txt", "new.txt");

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(workspaceRoot, "new.txt"), "utf8"), "hello");
});

test("tools enforce workspace boundary", async () => {
  const workspaceRoot = await createTempWorkspace();

  const result = await createFile(workspaceRoot, "../outside.txt", "unsafe");

  assert.equal(result.ok, false);
});

test("tool errors return ToolResult instead of raw throw", async () => {
  const result = await readFile("C:\\path\\that\\does\\not\\exist", "missing.txt");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(typeof result.error.code, "string");
    assert.equal(typeof result.error.message, "string");
  }
});
