import type {
  ActionPlan,
  FileAction,
  ValidationIssue,
  ValidationResult,
} from "../types/actionPlan.js";
import {
  SYMLINK_LIMITATION_NOTE,
  normalizeRelativePath,
  resolveWorkspacePath,
} from "../utils/pathUtils.js";

export interface SafetyValidatorOptions {
  maxActions?: number;
  pathExists?: (absolutePath: string) => boolean;
}

const DEFAULT_MAX_ACTIONS = 30;

export function validateActionPlanSafety(
  actionPlan: ActionPlan,
  workspaceRoot: string,
  options: SafetyValidatorOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const validatedActions: FileAction[] = [];
  const maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
  const pathExists = options.pathExists ?? (() => false);

  issues.push({
    level: "warning",
    code: "symlink_unsupported",
    message: SYMLINK_LIMITATION_NOTE,
  });

  if (actionPlan.actions.length > maxActions) {
    issues.push({
      level: "warning",
      code: "too_many_actions",
      message: `ActionPlan contains ${actionPlan.actions.length} actions, which exceeds the recommended limit of ${maxActions}.`,
    });
  }

  for (const action of actionPlan.actions) {
    const actionIssues = validateActionSafety(
      action as FileAction | UnsafeActionLike,
      workspaceRoot,
      pathExists,
    );
    issues.push(...actionIssues);

    if (!actionIssues.some((issue) => issue.level === "blocked")) {
      validatedActions.push(action);
    }
  }

  return {
    executable: !issues.some((issue) => issue.level === "blocked"),
    issues,
    validatedActions,
  };
}

interface UnsafeActionLike {
  id?: unknown;
  type?: unknown;
  path?: unknown;
  from?: unknown;
  to?: unknown;
}

function validateActionSafety(
  action: FileAction | UnsafeActionLike,
  workspaceRoot: string,
  pathExists: (absolutePath: string) => boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const actionId = typeof action.id === "string" && action.id.trim() ? action.id : "unknown-action";

  if (
    action.type !== "create_folder" &&
    action.type !== "create_file" &&
    action.type !== "move_file" &&
    action.type !== "rename_file" &&
    action.type !== "generate_word" &&
    action.type !== "generate_powerpoint" &&
    action.type !== "generate_excel"
  ) {
    issues.push(
      blocked(
        actionId,
        "unsupported_action",
        "Action type is not supported in the MVP validator.",
      ),
    );
    return issues;
  }

  switch (action.type) {
    case "create_folder": {
      const targetPath = validatePathField(actionId, "path", action.path, workspaceRoot, issues);

      if (targetPath && pathExists(targetPath)) {
        issues.push(warning(actionId, "target_exists", "Target folder already exists and may be redundant."));
      }

      return issues;
    }
    case "create_file": {
      const targetPath = validatePathField(actionId, "path", action.path, workspaceRoot, issues);

      if (targetPath && pathExists(targetPath)) {
        issues.push(
          warning(
            actionId,
            "overwrite_risk",
            "Target file already exists. Overwrite risk must be reviewed before execution.",
          ),
        );
      }

      return issues;
    }
    case "move_file":
    case "rename_file": {
      const sourcePath = validatePathField(actionId, "from", action.from, workspaceRoot, issues);
      const targetPath = validatePathField(actionId, "to", action.to, workspaceRoot, issues);

      if (sourcePath && !pathExists(sourcePath)) {
        issues.push(
          blocked(
            actionId,
            "source_missing",
            "Source path does not exist in the current workspace state.",
          ),
        );
      }

      if (targetPath && pathExists(targetPath)) {
        issues.push(
          blocked(
            actionId,
            "overwrite_risk",
            "Target path already exists. Move and rename overwrites are not supported in MVP.",
          ),
        );
      }

      return issues;
    }
    case "generate_word":
    case "generate_powerpoint":
    case "generate_excel": {
      const targetPath = validatePathField(actionId, "path", action.path, workspaceRoot, issues);
      const expectedExt =
        action.type === "generate_word" ? ".docx"
        : action.type === "generate_powerpoint" ? ".pptx"
        : ".xlsx";

      if (typeof action.path === "string") {
        const lower = action.path.toLowerCase();
        if (!lower.endsWith(expectedExt)) {
          issues.push(
            blocked(
              actionId,
              "invalid_extension",
              `Generated document target must end with ${expectedExt}.`,
            ),
          );
        }
      }

      // Document writers use { flag: "wx" } so existing files are never
      // overwritten. Block at validator-time too so the user sees the issue
      // before approval rather than at execution.
      if (targetPath && pathExists(targetPath)) {
        issues.push(
          blocked(
            actionId,
            "target_exists",
            "Target document already exists. Generated drafts do not overwrite files.",
          ),
        );
      }

      return issues;
    }
  }

  return issues;
}

function validatePathField(
  actionId: string,
  fieldName: "path" | "from" | "to",
  fieldValue: unknown,
  workspaceRoot: string,
  issues: ValidationIssue[],
): string | null {
  if (typeof fieldValue !== "string") {
    issues.push(
      blocked(
        actionId,
        "invalid_path",
        `Action ${fieldName} must be a string path.`,
      ),
    );
    return null;
  }

  try {
    normalizeRelativePath(fieldValue);
  } catch (error) {
    issues.push(mapPathError(actionId, fieldName, error));
    return null;
  }

  try {
    return resolveWorkspacePath(workspaceRoot, fieldValue);
  } catch {
    issues.push(
      blocked(
        actionId,
        "workspace_escape",
        `Action ${fieldName} resolves outside the workspace boundary.`,
      ),
    );
    return null;
  }
}

function mapPathError(
  actionId: string,
  fieldName: string,
  error: unknown,
): ValidationIssue {
  const message = error instanceof Error ? error.message : "Invalid path.";

  if (/empty/i.test(message)) {
    return blocked(actionId, "empty_path", `Action ${fieldName} must not be empty.`);
  }

  if (/absolute/i.test(message)) {
    return blocked(actionId, "absolute_path", `Action ${fieldName} must be workspace-relative.`);
  }

  if (/parent traversal/i.test(message)) {
    return blocked(actionId, "parent_traversal", `Action ${fieldName} must not use parent traversal.`);
  }

  return blocked(actionId, "invalid_path", `Action ${fieldName} is invalid.`);
}

function blocked(actionId: string, code: string, message: string): ValidationIssue {
  return {
    actionId,
    level: "blocked",
    code,
    message,
  };
}

function warning(actionId: string, code: string, message: string): ValidationIssue {
  return {
    actionId,
    level: "warning",
    code,
    message,
  };
}
