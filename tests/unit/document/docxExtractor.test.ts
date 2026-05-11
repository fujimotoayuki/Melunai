import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { extractDocxText } from "../../../src/document/docxExtractor.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-docx-"));
}

test("extractDocxText extracts headings and paragraphs from DOCX", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspaceRoot, "proposal.docx"),
    await createSimpleDocx([
      { style: "Heading1", text: "Project Proposal" },
      { text: "This document explains the plan." },
    ]),
  );

  const result = await extractDocxText(workspaceRoot, "proposal.docx", {
    maxParagraphsPerDocx: 10,
    maxCharsPerFile: 1_000,
  });

  assert.equal(result.status, "extracted");
  assert.equal(result.metadata?.paragraphCount, 2);
  assert.equal(result.segments[0]?.kind, "heading");
  assert.equal(result.segments[0]?.headingLevel, 1);
  assert.equal(result.segments[0]?.text, "Project Proposal");
  assert.equal(result.segments[1]?.kind, "paragraph");
});

test("extractDocxText enforces paragraph and character limits", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspaceRoot, "limited.docx"),
    await createSimpleDocx([
      { text: "First paragraph" },
      { text: "Second paragraph" },
    ]),
  );

  const result = await extractDocxText(workspaceRoot, "limited.docx", {
    maxParagraphsPerDocx: 1,
    maxCharsPerFile: 5,
  });

  assert.equal(result.status, "partial");
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.text, "First");
  assert.equal(result.truncated, true);
});

test("extractDocxText reports empty documents", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "empty.docx"), await createSimpleDocx([]));

  const result = await extractDocxText(workspaceRoot, "empty.docx");

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "empty_document");
});

test("extractDocxText rejects non-DOCX files and outside paths", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "not docx", "utf8");

  const unsupported = await extractDocxText(workspaceRoot, "notes.txt");
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.skipReason, "unsupported_type");

  const outside = await extractDocxText(workspaceRoot, "../outside.docx");
  assert.equal(outside.status, "skipped");
  assert.equal(outside.skipReason, "outside_workspace");
});

async function createSimpleDocx(
  paragraphs: Array<{ style?: "Heading1" | "Heading2"; text: string }>,
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.folder("_rels")?.file(".rels", rootRelationshipsXml());
  const word = zip.folder("word");
  word?.file("document.xml", documentXml(paragraphs));
  word?.file("styles.xml", stylesXml());
  word?.folder("_rels")?.file("document.xml.rels", documentRelationshipsXml());

  return zip.generateAsync({ type: "nodebuffer" });
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
}

function rootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function documentRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;
}

function documentXml(paragraphs: Array<{ style?: "Heading1" | "Heading2"; text: string }>): string {
  const body = paragraphs.map((paragraph) => {
    const style = paragraph.style === undefined
      ? ""
      : `<w:pPr><w:pStyle w:val="${paragraph.style}"/></w:pPr>`;
    return `<w:p>${style}<w:r><w:t>${escapeXml(paragraph.text)}</w:t></w:r></w:p>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
