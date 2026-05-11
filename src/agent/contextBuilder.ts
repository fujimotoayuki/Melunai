import type { FileNode, Workspace } from "../types/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FilePreview {
  /** Workspace-relative path */
  path: string;
  content: string;
  truncated: boolean;
}

export interface WorkspaceContext {
  /** Display name or root path of the workspace */
  workspaceName: string;
  /** Formatted, human-readable file tree */
  fileTree: string;
  /** Total number of files and directories in the listing */
  totalEntries: number;
  /** True if the listing was cut off due to maxEntries limit */
  truncated: boolean;
  /** Optional file previews explicitly passed by the caller */
  filePreviews: FilePreview[];
}

export interface BuildContextOptions {
  /**
   * Maximum number of file/directory entries to include in the tree.
   * Defaults to 100. Entries beyond this limit are omitted and
   * `WorkspaceContext.truncated` is set to true.
   */
  maxEntries?: number;
  /**
   * File previews to attach. The caller decides which files to preview
   * based on the user instruction. Context Builder does not read files.
   */
  filePreviews?: FilePreview[];
}

const DEFAULT_MAX_ENTRIES = 100;

// ---------------------------------------------------------------------------
// buildWorkspaceContext
// ---------------------------------------------------------------------------

/**
 * Builds a minimal workspace context for the Prompt Builder.
 *
 * Follows the context priority from docs/sdd/05_agent_behavior.md:
 *   1. File names and extensions
 *   2. File sizes
 *   3. (Cached summaries — not implemented in MVP)
 *   4. Short previews (caller-provided via options.filePreviews)
 *   5. Full content — not included by default
 *
 * Does NOT read the filesystem. All data comes from already-fetched FileNode[].
 * Does NOT dump the entire workspace into the context by default.
 */
export function buildWorkspaceContext(
  workspace: Workspace,
  fileTree: FileNode[],
  options: BuildContextOptions = {},
): WorkspaceContext {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const filePreviews = options.filePreviews ?? [];

  let entriesUsed = 0;
  let truncated = false;
  const lines: string[] = [];

  function walk(nodes: FileNode[], depth: number): void {
    for (const node of nodes) {
      if (entriesUsed >= maxEntries) {
        truncated = true;
        return;
      }

      const indent = "  ".repeat(depth);
      const sizeLabel =
        node.type === "file" && node.size !== undefined
          ? ` (${formatBytes(node.size)})`
          : "";
      const marker = node.type === "directory" ? "/" : "";

      lines.push(`${indent}${node.name}${marker}${sizeLabel}`);
      entriesUsed += 1;

      if (node.type === "directory" && node.children && node.children.length > 0) {
        walk(node.children, depth + 1);
      }
    }
  }

  walk(fileTree, 0);

  const fileTreeText =
    lines.length > 0 ? lines.join("\n") : "(empty workspace)";

  return {
    workspaceName: workspace.displayName || workspace.rootPath,
    fileTree: fileTreeText,
    totalEntries: entriesUsed,
    truncated,
    filePreviews,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
