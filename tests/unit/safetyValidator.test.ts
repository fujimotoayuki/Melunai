import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { validateActionPlanSafety } from "../../src/agent/safetyValidator.js";
import type { ActionPlan } from "../../src/types/actionPlan.js";

const WORKSPACE_ROOT = "C:\\workspace";

function createExistsStub(existingPaths: string[]) {
  const normalizedPaths = new Set(existingPaths.map((entry) => path.resolve(entry)));
  return (candidate: string) => normalizedPaths.has(path.resolve(candidate));
}

test("validateActionPlanSafety accepts safe create_folder paths", () => {
  const actionPlan: ActionPlan = {
    summary: "Create docs",
    actions: [
      {
        id: "action-1",
        type: "create_folder",
        description: "Create docs folder",
        path: "docs",
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, true);
  assert.equal(result.validatedActions.length, 1);
  assert.equal(result.issues.some((issue) => issue.level === "blocked"), false);
});

test("validateActionPlanSafety accepts safe move and rename paths", () => {
  const actionPlan: ActionPlan = {
    summary: "Move and rename",
    actions: [
      {
        id: "action-1",
        type: "move_file",
        description: "Move file",
        from: "inbox/file.txt",
        to: "archive/file.txt",
      },
      {
        id: "action-2",
        type: "rename_file",
        description: "Rename file",
        from: "docs/file.txt",
        to: "docs/file-renamed.txt",
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT, {
    pathExists: createExistsStub([
      "C:\\workspace\\inbox\\file.txt",
      "C:\\workspace\\docs\\file.txt",
    ]),
  });

  assert.equal(result.executable, true);
  assert.equal(result.validatedActions.length, 2);
});

test("validateActionPlanSafety rejects absolute paths", () => {
  const actionPlan: ActionPlan = {
    summary: "Unsafe path",
    actions: [
      {
        id: "action-1",
        type: "create_file",
        description: "Write outside",
        path: "C:\\secret.txt",
        content: "secret",
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, false);
  assert.equal(result.validatedActions.length, 0);
  assert.equal(result.issues.some((issue) => issue.code === "absolute_path"), true);
});

test("validateActionPlanSafety rejects parent traversal", () => {
  const actionPlan: ActionPlan = {
    summary: "Escape workspace",
    actions: [
      {
        id: "action-1",
        type: "create_folder",
        description: "Create outside",
        path: "../outside",
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, false);
  assert.equal(result.issues.some((issue) => issue.code === "parent_traversal"), true);
});

test("validateActionPlanSafety rejects unsupported action types at runtime", () => {
  const actionPlan = {
    summary: "Unsupported action",
    actions: [
      {
        id: "action-1",
        type: "delete_file",
        description: "Delete a file",
        path: "docs/file.txt",
      },
    ],
  } as unknown as ActionPlan;

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, false);
  assert.equal(result.validatedActions.length, 0);
  assert.equal(result.issues.some((issue) => issue.code === "unsupported_action"), true);
});

test("validateActionPlanSafety blocks missing move sources", () => {
  const actionPlan: ActionPlan = {
    summary: "Move missing file",
    actions: [
      {
        id: "action-1",
        type: "move_file",
        description: "Move missing file",
        from: "docs/missing.txt",
        to: "archive/missing.txt",
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, false);
  assert.equal(result.issues.some((issue) => issue.code === "source_missing"), true);
});

test("validateActionPlanSafety rejects empty paths", () => {
  const actionPlan: ActionPlan = {
    summary: "Empty path",
    actions: [
      {
        id: "action-1",
        type: "create_folder",
        description: "Create folder",
        path: "   ",
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, false);
  assert.equal(result.issues.some((issue) => issue.code === "empty_path"), true);
});

test("validateActionPlanSafety detects overwrite risk", () => {
  const actionPlan: ActionPlan = {
    summary: "Overwrite file",
    actions: [
      {
        id: "action-1",
        type: "create_file",
        description: "Create file",
        path: "docs/readme.md",
        content: "# Readme",
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT, {
    pathExists: createExistsStub(["C:\\workspace\\docs\\readme.md"]),
  });

  assert.equal(result.executable, true);
  assert.equal(result.issues.some((issue) => issue.code === "overwrite_risk"), true);
});

test("validateActionPlanSafety blocks move overwrite risk", () => {
  const actionPlan: ActionPlan = {
    summary: "Move onto existing file",
    actions: [
      {
        id: "action-1",
        type: "move_file",
        description: "Move file",
        from: "inbox/file.txt",
        to: "docs/file.txt",
        overwrite: true,
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT, {
    pathExists: createExistsStub([
      "C:\\workspace\\inbox\\file.txt",
      "C:\\workspace\\docs\\file.txt",
    ]),
  });

  assert.equal(result.executable, false);
  assert.equal(result.validatedActions.length, 0);
  assert.equal(
    result.issues.some((issue) => issue.code === "overwrite_risk" && issue.level === "blocked"),
    true,
  );
});

test("validateActionPlanSafety blocks rename overwrite risk", () => {
  const actionPlan: ActionPlan = {
    summary: "Rename onto existing file",
    actions: [
      {
        id: "action-1",
        type: "rename_file",
        description: "Rename file",
        from: "docs/old.txt",
        to: "docs/new.txt",
        overwrite: true,
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT, {
    pathExists: createExistsStub([
      "C:\\workspace\\docs\\old.txt",
      "C:\\workspace\\docs\\new.txt",
    ]),
  });

  assert.equal(result.executable, false);
  assert.equal(result.validatedActions.length, 0);
  assert.equal(
    result.issues.some((issue) => issue.code === "overwrite_risk" && issue.level === "blocked"),
    true,
  );
});

test("validateActionPlanSafety warns when action count exceeds the recommended limit", () => {
  const actionPlan: ActionPlan = {
    summary: "Large batch",
    actions: Array.from({ length: 3 }, (_, index) => ({
      id: `action-${index + 1}`,
      type: "create_folder" as const,
      description: `Create folder ${index + 1}`,
      path: `folder-${index + 1}`,
    })),
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT, {
    maxActions: 2,
  });

  assert.equal(result.executable, true);
  assert.equal(result.issues.some((issue) => issue.code === "too_many_actions"), true);
});

test("validateActionPlanSafety marks blocked plans as non-executable even when other actions are valid", () => {
  const actionPlan: ActionPlan = {
    summary: "Mixed safety",
    actions: [
      {
        id: "action-1",
        type: "create_folder",
        description: "Create docs",
        path: "docs",
      },
      {
        id: "action-2",
        type: "create_file",
        description: "Write outside",
        path: "/etc/passwd",
        content: "unsafe",
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, false);
  assert.equal(result.validatedActions.length, 1);
  assert.equal(result.issues.some((issue) => issue.level === "blocked"), true);
});

test("validateActionPlanSafety accepts safe document generation actions", () => {
  const actionPlan: ActionPlan = {
    summary: "Generate documents",
    actions: [
      {
        id: "action-1",
        type: "generate_word",
        description: "Create Word draft",
        path: "generated/proposal.docx",
        title: "Proposal",
        sections: [{ id: "section-1", heading: "Overview", paragraphs: ["Draft text."] }],
      },
      {
        id: "action-2",
        type: "generate_powerpoint",
        description: "Create deck",
        path: "generated/deck.pptx",
        title: "Deck",
        slides: [{ id: "slide-1", title: "Agenda", bullets: ["One"] }],
      },
      {
        id: "action-3",
        type: "generate_excel",
        description: "Create workbook",
        path: "generated/tasks.xlsx",
        title: "Tasks",
        sheets: [
          {
            id: "sheet-1",
            name: "Tasks",
            columns: [{ id: "task", header: "Task", valueType: "text" }],
          },
        ],
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, true);
  assert.equal(result.validatedActions.length, 3);
  assert.equal(result.issues.some((issue) => issue.level === "blocked"), false);
});

test("validateActionPlanSafety blocks generated document extension mismatch", () => {
  const actionPlan: ActionPlan = {
    summary: "Bad extension",
    actions: [
      {
        id: "action-1",
        type: "generate_word",
        description: "Create Word draft",
        path: "generated/proposal.txt",
        title: "Proposal",
        sections: [{ id: "section-1", heading: "Overview", paragraphs: ["Draft text."] }],
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT);

  assert.equal(result.executable, false);
  assert.equal(result.validatedActions.length, 0);
  assert.equal(
    result.issues.some((issue) => issue.code === "invalid_extension" && issue.level === "blocked"),
    true,
  );
});

test("validateActionPlanSafety blocks generated document target overwrite", () => {
  const actionPlan: ActionPlan = {
    summary: "Existing target",
    actions: [
      {
        id: "action-1",
        type: "generate_excel",
        description: "Create workbook",
        path: "generated/tasks.xlsx",
        title: "Tasks",
        sheets: [
          {
            id: "sheet-1",
            name: "Tasks",
            columns: [{ id: "task", header: "Task", valueType: "text" }],
          },
        ],
      },
    ],
  };

  const result = validateActionPlanSafety(actionPlan, WORKSPACE_ROOT, {
    pathExists: createExistsStub(["C:\\workspace\\generated\\tasks.xlsx"]),
  });

  assert.equal(result.executable, false);
  assert.equal(result.validatedActions.length, 0);
  assert.equal(
    result.issues.some((issue) => issue.code === "target_exists" && issue.level === "blocked"),
    true,
  );
});
