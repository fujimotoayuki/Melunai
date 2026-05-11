import assert from "node:assert/strict";
import test from "node:test";

import {
  SYMLINK_LIMITATION_NOTE,
  isPathWithinWorkspace,
  normalizeRelativePath,
  resolveWorkspacePath,
} from "../../src/utils/pathUtils.js";

test("normalizeRelativePath accepts a safe relative path", () => {
  assert.equal(normalizeRelativePath("docs/readme.md"), "docs/readme.md");
});

test("normalizeRelativePath rejects an empty path", () => {
  assert.throws(() => normalizeRelativePath("   "), /must not be empty/i);
});

test("normalizeRelativePath rejects an absolute Unix path", () => {
  assert.throws(
    () => normalizeRelativePath("/etc/passwd"),
    /absolute paths are not allowed/i,
  );
});

test("normalizeRelativePath rejects an absolute Windows path", () => {
  assert.throws(
    () => normalizeRelativePath("C:\\Users\\user\\secret.txt"),
    /absolute paths are not allowed/i,
  );
});

test("normalizeRelativePath rejects parent traversal", () => {
  assert.throws(
    () => normalizeRelativePath("../secret.txt"),
    /parent traversal is not allowed/i,
  );
});

test("normalizeRelativePath rejects nested parent traversal after normalization", () => {
  assert.throws(
    () => normalizeRelativePath("notes/../../secret.txt"),
    /parent traversal is not allowed/i,
  );
});

test("normalizeRelativePath normalizes safe separators and dot segments", () => {
  assert.equal(
    normalizeRelativePath("notes\\drafts/./plan.md"),
    "notes/drafts/plan.md",
  );
});

test("normalizeRelativePath preserves whitespace inside path segments", () => {
  assert.equal(
    normalizeRelativePath("project notes/weekly review.md"),
    "project notes/weekly review.md",
  );
});

test("resolveWorkspacePath returns an absolute path inside the workspace", () => {
  const resolvedPath = resolveWorkspacePath(
    "C:\\workspace",
    "docs\\readme.md",
  );

  assert.equal(
    resolvedPath,
    "C:\\workspace\\docs\\readme.md",
  );
});

test("isPathWithinWorkspace returns true for a nested workspace path", () => {
  assert.equal(
    isPathWithinWorkspace("C:\\workspace", "C:\\workspace\\docs\\readme.md"),
    true,
  );
});

test("isPathWithinWorkspace returns false for a workspace escape", () => {
  assert.equal(
    isPathWithinWorkspace("C:\\workspace", "C:\\outside\\secret.txt"),
    false,
  );
});

test("symlink limitation note is documented", () => {
  assert.match(SYMLINK_LIMITATION_NOTE, /symlink/i);
  assert.match(SYMLINK_LIMITATION_NOTE, /blocked in MVP/i);
});
