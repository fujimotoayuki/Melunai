import fs from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import type {
  DocumentGenerationApproval,
  DocumentGenerationPlan,
  DocumentGenerationResult,
  ExcelDraftColumn,
  ExcelDraftSheet,
  ExcelWorkbookSchema,
  ToolResult,
} from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

export async function createXlsxDraft(
  workspaceRoot: string,
  plan: DocumentGenerationPlan,
  approval: DocumentGenerationApproval,
): Promise<ToolResult<DocumentGenerationResult>> {
  try {
    const validation = validateApprovedExcelPlan(plan, approval);
    if (validation !== null) {
      return fail(validation.code, validation.message);
    }

    const draft = plan.draft as ExcelWorkbookSchema;
    const absolutePath = resolveWorkspacePath(workspaceRoot, draft.targetPath);

    if (path.extname(absolutePath).toLowerCase() !== ".xlsx") {
      return fail("invalid_extension", "XLSX draft generation requires a .xlsx target path.");
    }

    await rejectSymlinkTraversal(workspaceRoot, absolutePath, { includeTarget: false });
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    const workbook = buildWorkbook(draft);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await fs.writeFile(absolutePath, buffer, { flag: "wx" });

    return ok({
      planId: plan.id,
      status: "created",
      targetPath: draft.targetPath,
      createdAt: new Date().toISOString(),
      warnings: draft.warnings,
    });
  } catch (cause) {
    if (isFileExistsError(cause)) {
      return fail("target_exists", "Target XLSX already exists. Generated documents do not overwrite files.");
    }

    if (isUnsafePathError(cause)) {
      return fail("outside_workspace", "XLSX target path is outside the selected workspace or uses unsupported symlink traversal.", cause);
    }

    return fail("xlsx_generation_failed", "Unable to create XLSX draft.", cause);
  }
}

function buildWorkbook(draft: ExcelWorkbookSchema): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Melunai";
  workbook.company = "Melunai";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.title = draft.title;
  workbook.subject = draft.purpose ?? "";

  const sheets = draft.sheets.length > 0 ? draft.sheets : [fallbackSheet(draft)];

  for (const sheet of sheets) {
    const matrix = buildSheetMatrix(draft, sheet);
    const worksheet = workbook.addWorksheet(sanitizeSheetName(sheet.name));
    worksheet.addRows(matrix);
    buildColumnWidths(sheet).forEach((column, index) => {
      worksheet.getColumn(index + 1).width = column.width;
    });
  }

  return workbook;
}

function buildSheetMatrix(draft: ExcelWorkbookSchema, sheet: ExcelDraftSheet): Array<Array<string | number | boolean>> {
  const rows: Array<Array<string | number | boolean>> = [
    [draft.title],
    [draft.draftDisclaimer.message],
    [sheet.name],
  ];

  if (sheet.purpose !== undefined && sheet.purpose.trim().length > 0) {
    rows.push([sheet.purpose]);
  }

  rows.push([]);
  rows.push(sheet.columns.map((column) => column.header));

  const normalizedRows = normalizeSampleRows(sheet);
  if (normalizedRows.length === 0) {
    rows.push(sheet.columns.map(() => ""));
  } else {
    rows.push(...normalizedRows);
  }

  return rows;
}

function normalizeSampleRows(sheet: ExcelDraftSheet): Array<Array<string | number | boolean>> {
  return (sheet.sampleRows ?? []).map((row) =>
    sheet.columns.map((column) => normalizeCellValue(row[column.id] ?? row[column.header])),
  );
}

function normalizeCellValue(value: string | number | boolean | undefined): string | number | boolean {
  if (value === undefined) {
    return "";
  }

  if (typeof value === "string" && value.startsWith("=")) {
    return `'${value}`;
  }

  return value;
}

function buildColumnWidths(sheet: ExcelDraftSheet): Array<{ width: number }> {
  return sheet.columns.map((column) => ({
    width: clampColumnWidth(estimateColumnWidth(column)),
  }));
}

function estimateColumnWidth(column: ExcelDraftColumn): number {
  return Math.max(column.header.length + 4, column.description?.length ?? 0, 12);
}

function clampColumnWidth(width: number): number {
  return Math.max(10, Math.min(width, 36));
}

function fallbackSheet(draft: ExcelWorkbookSchema): ExcelDraftSheet {
  return {
    id: "sheet-1",
    name: draft.title.slice(0, 31) || "Draft",
    purpose: draft.purpose,
    columns: [{ id: "item", header: "Item", valueType: "text" }],
    sampleRows: [],
  };
}

function validateApprovedExcelPlan(
  plan: DocumentGenerationPlan,
  approval: DocumentGenerationApproval,
): { code: string; message: string } | null {
  if (plan.status !== "draft_proposed" || plan.requiresApproval !== true) {
    return { code: "invalid_plan_state", message: "Only proposed drafts that require approval can be generated." };
  }

  if (plan.draft.kind !== "excel" || plan.draft.extension !== ".xlsx") {
    return { code: "unsupported_draft_kind", message: "Only Excel .xlsx drafts are supported by this writer." };
  }

  if (approval.planId !== plan.id) {
    return { code: "approval_plan_mismatch", message: "Approval does not match the document generation plan." };
  }

  if (approval.approvedTargetPath !== plan.draft.targetPath) {
    return { code: "approval_target_mismatch", message: "Approval target path does not match the previewed draft." };
  }

  const blockedIssue = plan.issues.find((issue) => issue.level === "blocked");
  if (blockedIssue !== undefined) {
    return { code: blockedIssue.code, message: blockedIssue.message };
  }

  return null;
}

function sanitizeSheetName(name: string): string {
  const sanitized = name.replace(/[\\/?*\[\]:]/g, " ").trim().slice(0, 31);
  return sanitized.length > 0 ? sanitized : "Sheet";
}

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

function fail<T = never>(code: string, message: string, cause?: unknown): ToolResult<T> {
  return {
    ok: false,
    error: { code, message, cause },
  };
}

async function rejectSymlinkTraversal(
  workspaceRoot: string,
  absoluteTargetPath: string,
  options: { includeTarget?: boolean } = {},
): Promise<void> {
  const includeTarget = options.includeTarget ?? true;
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedTargetPath = path.resolve(absoluteTargetPath);
  const relativePath = path.relative(resolvedWorkspaceRoot, resolvedTargetPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Path escapes workspace.");
  }

  const parts = relativePath ? relativePath.split(path.sep) : [];
  const partsToCheck = includeTarget ? parts : parts.slice(0, -1);
  let currentPath = resolvedWorkspaceRoot;

  const rootStats = await fs.lstat(currentPath);
  if (rootStats.isSymbolicLink()) {
    throw new Error("Symlink traversal is not supported.");
  }

  for (const part of partsToCheck) {
    currentPath = path.join(currentPath, part);

    try {
      const stats = await fs.lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error("Symlink traversal is not supported.");
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }

      throw error;
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST",
  );
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function isUnsafePathError(error: unknown): boolean {
  return error instanceof Error &&
    (
      error.message.includes("Absolute paths are not allowed") ||
      error.message.includes("Parent traversal is not allowed") ||
      error.message.includes("escapes workspace") ||
      error.message.includes("Symlink traversal is not supported")
    );
}
