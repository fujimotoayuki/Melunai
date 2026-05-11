import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractPdfText } from "../../../src/document/pdfExtractor.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-pdf-"));
}

test("extractPdfText extracts text from a text-based PDF", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspaceRoot, "hello.pdf"),
    createSimplePdf(["Hello Melunai PDF"]),
  );

  const result = await extractPdfText(workspaceRoot, "hello.pdf", {
    maxPagesPerPdf: 5,
    maxCharsPerFile: 1_000,
  });

  assert.equal(result.status, "extracted");
  assert.equal(result.metadata?.pageCount, 1);
  assert.equal(result.segments.length, 1);
  assert.match(result.segments[0]?.text ?? "", /Hello Melunai PDF/);
});

test("extractPdfText enforces page and character limits", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspaceRoot, "limited.pdf"),
    createSimplePdf(["First page text", "Second page text"]),
  );

  const result = await extractPdfText(workspaceRoot, "limited.pdf", {
    maxPagesPerPdf: 1,
    maxCharsPerFile: 6,
  });

  assert.equal(result.status, "partial");
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.pageNumber, 1);
  assert.equal(result.segments[0]?.text, "First ");
  assert.equal(result.truncated, true);
});

test("extractPdfText reports image-only PDFs as OCR-required", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "blank.pdf"), createSimplePdf([""]));

  const result = await extractPdfText(workspaceRoot, "blank.pdf", {
    maxPagesPerPdf: 5,
    maxCharsPerFile: 1_000,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "scanned_pdf_ocr_required");
});

test("extractPdfText rejects non-PDF files and outside paths", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "not pdf", "utf8");

  const unsupported = await extractPdfText(workspaceRoot, "notes.txt");
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.skipReason, "unsupported_type");

  const outside = await extractPdfText(workspaceRoot, "../outside.pdf");
  assert.equal(outside.status, "skipped");
  assert.equal(outside.skipReason, "outside_workspace");
});

function createSimplePdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];

  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("PAGES_PLACEHOLDER");

  for (const text of pageTexts) {
    const contentObjectNumber = objects.length + 2;
    const pageObjectNumber = objects.length + 1;
    pageObjectNumbers.push(pageObjectNumber);

    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${contentObjectNumber + 1} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`);
    const stream = `BT /F1 24 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((num) => `${num} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "ascii");
}

function escapePdfText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}
