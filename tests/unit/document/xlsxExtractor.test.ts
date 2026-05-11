import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { extractXlsxText } from "../../../src/document/xlsxExtractor.js";

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "melunai-xlsx-"));
}

test("extractXlsxText extracts sheet names and visible values", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeWorkbook(path.join(workspaceRoot, "book.xlsx"), [
    {
      name: "Tasks",
      rows: [
        ["Name", "Status"],
        ["Write spec", "Done"],
      ],
    },
  ]);

  const result = await extractXlsxText(workspaceRoot, "book.xlsx", {
    maxSheetsPerXlsx: 5,
    maxCellsPerSheet: 100,
    maxCharsPerFile: 1_000,
  });

  assert.equal(result.status, "extracted");
  assert.equal(result.metadata?.sheetCount, 1);
  assert.equal(result.segments[0]?.kind, "sheet");
  assert.equal(result.segments[0]?.sheetName, "Tasks");
  assert.match(result.segments[0]?.text ?? "", /Name\tStatus/);
  assert.match(result.segments[0]?.text ?? "", /Write spec\tDone/);
});

test("extractXlsxText enforces sheet, cell, and character limits", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeWorkbook(path.join(workspaceRoot, "limited.xlsx"), [
    { name: "First", rows: [["A", "B"], ["C", "D"]] },
    { name: "Second", rows: [["E", "F"]] },
  ]);

  const result = await extractXlsxText(workspaceRoot, "limited.xlsx", {
    maxSheetsPerXlsx: 1,
    maxCellsPerSheet: 2,
    maxCharsPerFile: 3,
  });

  assert.equal(result.status, "partial");
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.sheetName, "First");
  assert.equal(result.segments[0]?.text, "A\tB");
  assert.equal(result.truncated, true);
});

test("extractXlsxText reports empty workbooks", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeWorkbook(path.join(workspaceRoot, "empty.xlsx"), [
    { name: "Empty", rows: [] },
  ]);

  const result = await extractXlsxText(workspaceRoot, "empty.xlsx");

  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "empty_document");
});

test("extractXlsxText rejects non-XLSX files and outside paths", async () => {
  const workspaceRoot = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "not xlsx", "utf8");

  const unsupported = await extractXlsxText(workspaceRoot, "notes.txt");
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.skipReason, "unsupported_type");

  const outside = await extractXlsxText(workspaceRoot, "../outside.xlsx");
  assert.equal(outside.status, "skipped");
  assert.equal(outside.skipReason, "outside_workspace");
});

async function writeWorkbook(
  filePath: string,
  sheets: Array<{ name: string; rows: Array<Array<string | number | boolean>> }>,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    worksheet.addRows(sheet.rows);
  }

  await workbook.xlsx.writeFile(filePath);
}
