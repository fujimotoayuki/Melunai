import path from "node:path";

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function normalizeSeparators(input: string): string {
  return input.replace(/\\/g, "/");
}

function hasParentTraversal(normalizedPath: string): boolean {
  return (
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../")
  );
}

export function normalizeRelativePath(inputPath: string): string {
  const trimmedPath = inputPath.trim();

  if (!trimmedPath) {
    throw new Error("Path must not be empty.");
  }

  if (
    path.posix.isAbsolute(trimmedPath) ||
    path.win32.isAbsolute(trimmedPath) ||
    WINDOWS_ABSOLUTE_PATH.test(trimmedPath)
  ) {
    throw new Error("Absolute paths are not allowed.");
  }

  const normalizedPath = path.posix.normalize(normalizeSeparators(trimmedPath));

  if (normalizedPath === "." || !normalizedPath) {
    throw new Error("Path must not be empty.");
  }

  if (hasParentTraversal(normalizedPath)) {
    throw new Error("Parent traversal is not allowed.");
  }

  return normalizedPath;
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): string {
  const safeRelativePath = normalizeRelativePath(relativePath);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedTargetPath = path.resolve(resolvedWorkspaceRoot, safeRelativePath);

  if (!isPathWithinWorkspace(resolvedWorkspaceRoot, resolvedTargetPath)) {
    throw new Error("Resolved path escapes the workspace.");
  }

  return resolvedTargetPath;
}

export function isPathWithinWorkspace(
  workspaceRoot: string,
  targetPath: string,
): boolean {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  const relativePath = path.relative(resolvedWorkspaceRoot, resolvedTargetPath);

  if (!relativePath) {
    return true;
  }

  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ""
  );
}

export const SYMLINK_LIMITATION_NOTE =
  "Symlink-safe workspace enforcement is not implemented yet. Callers should treat symlink traversal as blocked in MVP.";
