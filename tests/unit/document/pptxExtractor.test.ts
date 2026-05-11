import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { extractPptxText } from "../../../src/document/pptxExtractor.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-pptx-"));
}

test("extractPptxText extracts slides in presentation order", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspaceRoot, "deck.pptx"),
    await createSimplePptx([
      ["Title One", "First bullet"],
      ["Title Two", "Second bullet"],
    ]),
  );

  const result = await extractPptxText(workspaceRoot, "deck.pptx", {
    maxSlidesPerPptx: 10,
    maxCharsPerFile: 1_000,
  });

  assert.equal(result.status, "extracted");
  assert.equal(result.metadata?.slideCount, 2);
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0]?.slideNumber, 1);
  assert.match(result.segments[0]?.text ?? "", /Title One/);
  assert.match(result.segments[1]?.text ?? "", /Title Two/);
});

test("extractPptxText enforces slide and character limits", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspaceRoot, "limited.pptx"),
    await createSimplePptx([
      ["First Slide", "Long text"],
      ["Second Slide", "Ignored"],
    ]),
  );

  const result = await extractPptxText(workspaceRoot, "limited.pptx", {
    maxSlidesPerPptx: 1,
    maxCharsPerFile: 5,
  });

  assert.equal(result.status, "partial");
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.text, "First");
  assert.equal(result.truncated, true);
});

test("extractPptxText reports empty decks", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "empty.pptx"), await createSimplePptx([[]]));

  const result = await extractPptxText(workspaceRoot, "empty.pptx");

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "empty_document");
});

test("extractPptxText rejects non-PPTX files and outside paths", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "not pptx", "utf8");

  const unsupported = await extractPptxText(workspaceRoot, "notes.txt");
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.skipReason, "unsupported_type");

  const outside = await extractPptxText(workspaceRoot, "../outside.pptx");
  assert.equal(outside.status, "skipped");
  assert.equal(outside.skipReason, "outside_workspace");
});

async function createSimplePptx(slides: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml(slides.length));
  zip.folder("_rels")?.file(".rels", rootRelationshipsXml());
  const ppt = zip.folder("ppt");
  ppt?.file("presentation.xml", presentationXml(slides.length));
  ppt?.folder("_rels")?.file("presentation.xml.rels", presentationRelationshipsXml(slides.length));
  const slideFolder = ppt?.folder("slides");

  slides.forEach((texts, index) => {
    slideFolder?.file(`slide${index + 1}.xml`, slideXml(texts));
  });

  return zip.generateAsync({ type: "nodebuffer" });
}

function contentTypesXml(slideCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, index) =>
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slideOverrides}
</Types>`;
}

function rootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
}

function presentationXml(slideCount: number): string {
  const slideIds = Array.from({ length: slideCount }, (_, index) =>
    `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>${slideIds}</p:sldIdLst>
</p:presentation>`;
}

function presentationRelationshipsXml(slideCount: number): string {
  const relationships = Array.from({ length: slideCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relationships}
</Relationships>`;
}

function slideXml(texts: string[]): string {
  const shapes = texts.map((text) => `
    <p:sp>
      <p:txBody>
        <a:bodyPr/>
        <a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
  `).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>${shapes}</p:spTree></p:cSld>
</p:sld>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
