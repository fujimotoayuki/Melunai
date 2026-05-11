import fs from "node:fs/promises";
import path from "node:path";

import type { FileNode, ToolResult } from "../types/index.js";
import { resolveWorkspacePath } from "../utils/pathUtils.js";

const SUPPORTED_TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv"]);
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MAX_TREE_ENTRIES = 1_000;

export interface ReadFileData {
  path: string;
  absolutePath: string;
  content: string;
  truncated: boolean;
  size: number;
}

export interface CreateFolderData {
  path: string;
  absolutePath: string;
  created: boolean;
}

export interface CreateFileData {
  path: string;
  absolutePath: string;
  overwritten: boolean;
}

export interface MoveFileData {
  from: string;
  to: string;
  absoluteFrom: string;
  absoluteTo: string;
  overwritten: boolean;
}

export async function listFolder(
  workspaceRoot: string,
  relativePath?: string,
): Promise<ToolResult<FileNode[]>> {
  try {
    const absolutePath = resolveToolPath(workspaceRoot, relativePath, true);
    await rejectSymlinkTraversal(workspaceRoot, absolutePath);

    let entriesUsed = 0;
    const nodes = await listFolderRecursive(workspaceRoot, absolutePath, () => {
      entriesUsed += 1;
      return entriesUsed <= DEFAULT_MAX_TREE_ENTRIES;
    });

    return ok(nodes);
  } catch (cause) {
    return fail("list_folder_failed", "Unable to list folder contents.", cause);
  }
}

async function listFolderRecursive(
  workspaceRoot: string,
  absolutePath: string,
  canAddEntry: () => boolean,
): Promise<FileNode[]> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (!canAddEntry()) break;
    if (entry.isSymbolicLink()) continue;

    const childAbsolutePath = path.join(absolutePath, entry.name);
    const childRelativePath = toWorkspaceRelativePath(workspaceRoot, childAbsolutePath);

    try {
      const stats = await fs.stat(childAbsolutePath);
      const isDirectory = entry.isDirectory();
      const node: FileNode = {
        name: entry.name,
        path: childRelativePath,
        type: isDirectory ? "directory" : "file",
        extension: entry.isFile() ? path.extname(entry.name).toLowerCase() : undefined,
        size: entry.isFile() ? stats.size : undefined,
        modifiedAt: stats.mtime.toISOString(),
      };

      if (isDirectory) {
        node.children = await listFolderRecursive(workspaceRoot, childAbsolutePath, canAddEntry);
      }

      nodes.push(node);
    } catch {
      continue;
    }
  }

  nodes.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  return nodes;
}

export async function readFile(
  workspaceRoot: string,
  relativePath: string,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<ToolResult<ReadFileData>> {
  try {
    const absolutePath = resolveToolPath(workspaceRoot, relativePath);
    await rejectSymlinkTraversal(workspaceRoot, absolutePath);

    const extension = path.extname(absolutePath).toLowerCase();
    if (!SUPPORTED_TEXT_EXTENSIONS.has(extension)) {
      return fail("unsupported_file_type", `Unsupported file type: ${extension || "(none)"}.`);
    }

    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return fail("not_a_file", "Path does not point to a file.");
    }

    const content = await fs.readFile(absolutePath, "utf8");
    const truncated = content.length > maxChars;

    return ok({
      path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
      absolutePath,
      content: truncated ? content.slice(0, maxChars) : content,
      truncated,
      size: stats.size,
    });
  } catch (cause) {
    return fail("read_file_failed", "Unable to read file.", cause);
  }
}

export async function createFolder(
  workspaceRoot: string,
  relativePath: string,
): Promise<ToolResult<CreateFolderData>> {
  try {
    const absolutePath = resolveToolPath(workspaceRoot, relativePath);
    await rejectSymlinkTraversal(workspaceRoot, absolutePath, { includeTarget: false });

    const existing = await pathExists(absolutePath);
    if (existing) {
      const stats = await fs.stat(absolutePath);

      if (!stats.isDirectory()) {
        return fail("target_exists", "Target path already exists and is not a folder.");
      }

      return ok({
        path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
        absolutePath,
        created: false,
      });
    }

    await fs.mkdir(absolutePath, { recursive: true });

    return ok({
      path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
      absolutePath,
      created: true,
    });
  } catch (cause) {
    return fail("create_folder_failed", "Unable to create folder.", cause);
  }
}

export async function createFile(
  workspaceRoot: string,
  relativePath: string,
  content: string,
  overwrite = false,
): Promise<ToolResult<CreateFileData>> {
  try {
    const absolutePath = resolveToolPath(workspaceRoot, relativePath);
    await rejectSymlinkTraversal(workspaceRoot, absolutePath, { includeTarget: false });

    const existing = await pathExists(absolutePath);
    if (existing && !overwrite) {
      return fail("target_exists", "Target file already exists and overwrite is not approved.");
    }

    if (existing) {
      await rejectSymlinkTraversal(workspaceRoot, absolutePath);
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, {
      encoding: "utf8",
      flag: overwrite ? "w" : "wx",
    });

    return ok({
      path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
      absolutePath,
      overwritten: existing,
    });
  } catch (cause) {
    return fail("create_file_failed", "Unable to create file.", cause);
  }
}

export async function moveFile(
  workspaceRoot: string,
  from: string,
  to: string,
  overwrite = false,
): Promise<ToolResult<MoveFileData>> {
  try {
    const absoluteFrom = resolveToolPath(workspaceRoot, from);
    const absoluteTo = resolveToolPath(workspaceRoot, to);

    await rejectSymlinkTraversal(workspaceRoot, absoluteFrom);
    await rejectSymlinkTraversal(workspaceRoot, absoluteTo, { includeTarget: false });

    const sourceStats = await fs.stat(absoluteFrom).catch(() => null);
    if (!sourceStats?.isFile()) {
      return fail("source_missing", "Source file does not exist.");
    }

    const targetExists = await pathExists(absoluteTo);
    if (targetExists) {
      const code = overwrite ? "overwrite_unsupported" : "target_exists";
      return fail(code, "Target path already exists. Move overwrite is not supported in MVP.");
    }

    await fs.mkdir(path.dirname(absoluteTo), { recursive: true });

    await fs.rename(absoluteFrom, absoluteTo);

    return ok({
      from: toWorkspaceRelativePath(workspaceRoot, absoluteFrom),
      to: toWorkspaceRelativePath(workspaceRoot, absoluteTo),
      absoluteFrom,
      absoluteTo,
      overwritten: targetExists,
    });
  } catch (cause) {
    return fail("move_file_failed", "Unable to move file.", cause);
  }
}

export async function renameFile(
  workspaceRoot: string,
  from: string,
  to: string,
  overwrite = false,
): Promise<ToolResult<MoveFileData>> {
  return moveFile(workspaceRoot, from, to, overwrite);
}

function resolveToolPath(
  workspaceRoot: string,
  relativePath?: string,
  allowRoot = false,
): string {
  if (allowRoot && (relativePath === undefined || relativePath.trim() === "" || relativePath.trim() === ".")) {
    return path.resolve(workspaceRoot);
  }

  if (relativePath === undefined) {
    throw new Error("Path must not be empty.");
  }

  return resolveWorkspacePath(workspaceRoot, relativePath);
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

  try {
    const rootStats = await fs.lstat(currentPath);
    if (rootStats.isSymbolicLink()) {
      throw new Error("Symlink traversal is not supported in MVP.");
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  for (const part of partsToCheck) {
    currentPath = path.join(currentPath, part);

    try {
      const stats = await fs.lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error("Symlink traversal is not supported in MVP.");
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }

      throw error;
    }
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath)).replaceAll(path.sep, "/");
}

function ok<T>(data: T): ToolResult<T> {
  return {
    ok: true,
    data,
  };
}

function fail<T = never>(code: string, message: string, cause?: unknown): ToolResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      cause,
    },
  };
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}
