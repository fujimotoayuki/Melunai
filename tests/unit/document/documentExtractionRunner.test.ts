import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractDocuments, toDocumentSourceSelection } from "../../../src/document/documentExtractionRunner.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-documents-"));
}

test("toDocumentSourceSelection accepts supported document extensions", () => {
  assert.equal(toDocumentSourceSelection("a.pdf")?.kind, "pdf");
  assert.equal(toDocumentSourceSelection("b.docx")?.kind, "word");
  assert.equal(toDocumentSourceSelection("c.xlsx")?.kind, "excel");
  assert.equal(toDocumentSourceSelection("d.pptx")?.kind, "powerpoint");
  assert.equal(toDocumentSourceSelection("e.txt"), null);
});

test("extractDocuments returns structured unsupported document results", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "hello", "utf8");

  const result = await extractDocuments({
    workspaceRoot,
    paths: ["notes.txt"],
    userInstruction: "summarize",
    limits: { maxFiles: 4 },
  });

  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0]?.status, "unsupported");
  assert.equal(result.documentSummaries[0]?.sourceStatus, "unsupported");
  assert.equal(result.combinedSummary?.summary, "Prepared 0 document(s) for: summarize");
});
