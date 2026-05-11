import type {
  ActionPlan,
  ActionType,
  FileAction,
} from "../types/actionPlan.js";
import type {
  ExcelDraftColumn,
  ExcelDraftSheet,
  PowerPointDraftSlide,
  WordDraftSection,
} from "../types/documentGeneration.js";

type ActionShape = Record<string, unknown>;

export type ActionPlanParserErrorCode =
  | "empty_response"
  | "invalid_json"
  | "multiple_json_objects"
  | "non_object_action_plan"
  | "missing_summary"
  | "missing_actions"
  | "empty_actions"
  | "unknown_action_type"
  | "missing_required_field";

export type ActionPlanParserResult =
  | {
      ok: true;
      data: ActionPlan;
    }
  | {
      ok: false;
      error: {
        code: ActionPlanParserErrorCode;
        message: string;
      };
    };

type ActionValidationResult =
  | {
      ok: true;
      data: FileAction;
    }
  | {
      ok: false;
      error: {
        code: ActionPlanParserErrorCode;
        message: string;
      };
    };

const ALLOWED_ACTION_TYPES: ActionType[] = [
  "create_folder",
  "create_file",
  "move_file",
  "rename_file",
  "generate_word",
  "generate_powerpoint",
  "generate_excel",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObjectCandidates(input: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        startIndex = index;
      }

      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth === 0) {
        continue;
      }

      depth -= 1;

      if (depth === 0 && startIndex >= 0) {
        candidates.push(input.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return candidates;
}

function parseJsonCandidate(input: string): ActionPlanParserResult {
  let parsedValue: unknown;

  try {
    parsedValue = JSON.parse(input);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_json",
        message: "ActionPlan JSON could not be parsed.",
      },
    };
  }

  return validateActionPlan(parsedValue);
}

function validateActionPlan(input: unknown): ActionPlanParserResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: {
        code: "non_object_action_plan",
        message: "ActionPlan must be a JSON object.",
      },
    };
  }

  if (typeof input.summary !== "string" || input.summary.trim() === "") {
    return {
      ok: false,
      error: {
        code: "missing_summary",
        message: "ActionPlan summary is required.",
      },
    };
  }

  if (!Array.isArray(input.actions)) {
    return {
      ok: false,
      error: {
        code: "missing_actions",
        message: "ActionPlan actions array is required.",
      },
    };
  }

  if (input.actions.length === 0) {
    return {
      ok: false,
      error: {
        code: "empty_actions",
        message: "ActionPlan actions must not be empty.",
      },
    };
  }

  const validatedActions: FileAction[] = [];

  for (const action of input.actions) {
    const validatedAction = validateAction(action);

    if (!validatedAction.ok) {
      return validatedAction;
    }

    validatedActions.push(validatedAction.data);
  }

  return {
    ok: true,
    data: {
      summary: input.summary,
      actions: validatedActions,
    },
  };
}

function validateAction(input: unknown): ActionValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: {
        code: "missing_required_field",
        message: "Each action must be an object with required fields.",
      },
    };
  }

  if (
    typeof input.id !== "string" ||
    input.id.trim() === "" ||
    typeof input.description !== "string" ||
    input.description.trim() === ""
  ) {
    return {
      ok: false,
      error: {
        code: "missing_required_field",
        message: "Each action must include non-empty id and description fields.",
      },
    };
  }

  if (typeof input.type !== "string" || !ALLOWED_ACTION_TYPES.includes(input.type as ActionType)) {
    return {
      ok: false,
      error: {
        code: "unknown_action_type",
        message: "ActionPlan contains an unknown or unsupported action type.",
      },
    };
  }

  return validateActionFieldsByType(input, input.type as ActionType);
}

function validateActionFieldsByType(
  action: ActionShape,
  type: ActionType,
): ActionValidationResult {
  switch (type) {
    case "create_folder":
      if (typeof action.path !== "string" || action.path.trim() === "") {
        return missingFieldResult("create_folder action requires a non-empty path.");
      }

      return {
        ok: true,
        data: {
          id: action.id as string,
          type,
          description: action.description as string,
          path: action.path,
        },
      };
    case "create_file":
      if (typeof action.path !== "string" || action.path.trim() === "") {
        return missingFieldResult("create_file action requires a non-empty path.");
      }

      if (typeof action.content !== "string") {
        return missingFieldResult("create_file action requires content.");
      }

      return {
        ok: true,
        data: {
          id: action.id as string,
          type,
          description: action.description as string,
          path: action.path,
          content: action.content,
          overwrite: typeof action.overwrite === "boolean" ? action.overwrite : undefined,
        },
      };
    case "move_file":
    case "rename_file":
      if (typeof action.from !== "string" || action.from.trim() === "") {
        return missingFieldResult(`${type} action requires a non-empty from path.`);
      }

      if (typeof action.to !== "string" || action.to.trim() === "") {
        return missingFieldResult(`${type} action requires a non-empty to path.`);
      }

      return {
        ok: true,
        data: {
          id: action.id as string,
          type,
          description: action.description as string,
          from: action.from,
          to: action.to,
          overwrite: typeof action.overwrite === "boolean" ? action.overwrite : undefined,
        },
      };
    case "generate_word":
      return validateGenerateWord(action);
    case "generate_powerpoint":
      return validateGeneratePowerPoint(action);
    case "generate_excel":
      return validateGenerateExcel(action);
  }
}

// ---------------------------------------------------------------------------
// Document generation action validators (TASK-031)
// ---------------------------------------------------------------------------

function validateGenerateWord(action: ActionShape): ActionValidationResult {
  if (typeof action.path !== "string" || action.path.trim() === "") {
    return missingFieldResult("generate_word action requires a non-empty path.");
  }
  if (typeof action.title !== "string" || action.title.trim() === "") {
    return missingFieldResult("generate_word action requires a non-empty title.");
  }
  if (!Array.isArray(action.sections) || action.sections.length === 0) {
    return missingFieldResult("generate_word action requires at least one section.");
  }

  const sections: WordDraftSection[] = [];
  for (let i = 0; i < action.sections.length; i += 1) {
    const raw = action.sections[i];
    if (!isRecord(raw)) {
      return missingFieldResult(`generate_word section ${i + 1} must be an object.`);
    }
    if (typeof raw.heading !== "string" || raw.heading.trim() === "") {
      return missingFieldResult(`generate_word section ${i + 1} requires a heading.`);
    }
    if (!Array.isArray(raw.paragraphs) || raw.paragraphs.length === 0) {
      return missingFieldResult(`generate_word section ${i + 1} requires at least one paragraph.`);
    }
    const paragraphs: string[] = [];
    for (const p of raw.paragraphs) {
      if (typeof p !== "string") {
        return missingFieldResult(`generate_word section ${i + 1} paragraphs must be strings.`);
      }
      paragraphs.push(p);
    }
    const bullets =
      Array.isArray(raw.bullets)
        ? raw.bullets.filter((b): b is string => typeof b === "string")
        : undefined;
    sections.push({
      id: typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id : `section-${i + 1}`,
      heading: raw.heading,
      paragraphs,
      ...(bullets !== undefined && bullets.length > 0 ? { bullets } : {}),
    });
  }

  return {
    ok: true,
    data: {
      id: action.id as string,
      type: "generate_word",
      description: action.description as string,
      path: action.path,
      title: action.title,
      ...(typeof action.purpose === "string" ? { purpose: action.purpose } : {}),
      sections,
    },
  };
}

function validateGeneratePowerPoint(action: ActionShape): ActionValidationResult {
  if (typeof action.path !== "string" || action.path.trim() === "") {
    return missingFieldResult("generate_powerpoint action requires a non-empty path.");
  }
  if (typeof action.title !== "string" || action.title.trim() === "") {
    return missingFieldResult("generate_powerpoint action requires a non-empty title.");
  }
  if (!Array.isArray(action.slides) || action.slides.length === 0) {
    return missingFieldResult("generate_powerpoint action requires at least one slide.");
  }

  const slides: PowerPointDraftSlide[] = [];
  for (let i = 0; i < action.slides.length; i += 1) {
    const raw = action.slides[i];
    if (!isRecord(raw)) {
      return missingFieldResult(`generate_powerpoint slide ${i + 1} must be an object.`);
    }
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      return missingFieldResult(`generate_powerpoint slide ${i + 1} requires a title.`);
    }
    if (!Array.isArray(raw.bullets)) {
      return missingFieldResult(`generate_powerpoint slide ${i + 1} requires bullets array.`);
    }
    const bullets: string[] = [];
    for (const b of raw.bullets) {
      if (typeof b === "string") bullets.push(b);
    }
    slides.push({
      id: typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id : `slide-${i + 1}`,
      title: raw.title,
      bullets,
      ...(typeof raw.subtitle === "string" ? { subtitle: raw.subtitle } : {}),
      ...(typeof raw.speakerNotes === "string" ? { speakerNotes: raw.speakerNotes } : {}),
    });
  }

  return {
    ok: true,
    data: {
      id: action.id as string,
      type: "generate_powerpoint",
      description: action.description as string,
      path: action.path,
      title: action.title,
      ...(typeof action.purpose === "string" ? { purpose: action.purpose } : {}),
      slides,
    },
  };
}

function validateGenerateExcel(action: ActionShape): ActionValidationResult {
  if (typeof action.path !== "string" || action.path.trim() === "") {
    return missingFieldResult("generate_excel action requires a non-empty path.");
  }
  if (typeof action.title !== "string" || action.title.trim() === "") {
    return missingFieldResult("generate_excel action requires a non-empty title.");
  }
  if (!Array.isArray(action.sheets) || action.sheets.length === 0) {
    return missingFieldResult("generate_excel action requires at least one sheet.");
  }

  const sheets: ExcelDraftSheet[] = [];
  for (let i = 0; i < action.sheets.length; i += 1) {
    const raw = action.sheets[i];
    if (!isRecord(raw)) {
      return missingFieldResult(`generate_excel sheet ${i + 1} must be an object.`);
    }
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      return missingFieldResult(`generate_excel sheet ${i + 1} requires a name.`);
    }
    if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
      return missingFieldResult(`generate_excel sheet ${i + 1} requires at least one column.`);
    }
    const columns: ExcelDraftColumn[] = [];
    for (let j = 0; j < raw.columns.length; j += 1) {
      const col = raw.columns[j];
      if (!isRecord(col) || typeof col.header !== "string" || col.header.trim() === "") {
        return missingFieldResult(`generate_excel sheet ${i + 1} column ${j + 1} requires a header.`);
      }
      const valueType = (typeof col.valueType === "string" &&
        ["text", "number", "date", "currency", "boolean"].includes(col.valueType))
        ? (col.valueType as ExcelDraftColumn["valueType"])
        : "text";
      columns.push({
        id: typeof col.id === "string" && col.id.trim() !== "" ? col.id : `col-${j + 1}`,
        header: col.header,
        valueType,
        ...(typeof col.description === "string" ? { description: col.description } : {}),
      });
    }
    const sampleRows = Array.isArray(raw.sampleRows)
      ? validateExcelSampleRows(raw.sampleRows)
      : undefined;
    if (sampleRows === null) {
      return missingFieldResult(`generate_excel sheet ${i + 1} sampleRows must contain only string, number, or boolean cell values.`);
    }
    sheets.push({
      id: typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id : `sheet-${i + 1}`,
      name: raw.name,
      columns,
      ...(typeof raw.purpose === "string" ? { purpose: raw.purpose } : {}),
      ...(sampleRows !== undefined && sampleRows.length > 0 ? { sampleRows } : {}),
    });
  }

  return {
    ok: true,
    data: {
      id: action.id as string,
      type: "generate_excel",
      description: action.description as string,
      path: action.path,
      title: action.title,
      ...(typeof action.purpose === "string" ? { purpose: action.purpose } : {}),
      sheets,
    },
  };
}

function validateExcelSampleRows(
  rows: unknown[],
): Array<Record<string, string | number | boolean>> | null {
  const sampleRows: Array<Record<string, string | number | boolean>> = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!isRecord(row)) {
      return null;
    }

    const normalizedRow: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(row)) {
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        return null;
      }
      normalizedRow[key] = value;
    }

    sampleRows.push(normalizedRow);
  }

  return sampleRows;
}

function missingFieldResult(message: string): ActionValidationResult {
  return {
    ok: false,
    error: {
      code: "missing_required_field",
      message,
    },
  };
}

export function parseActionPlan(input: string): ActionPlanParserResult {
  const trimmedInput = input.trim();

  if (!trimmedInput) {
    return {
      ok: false,
      error: {
        code: "empty_response",
        message: "ActionPlan response must not be empty.",
      },
    };
  }

  try {
    const parsedValue = JSON.parse(trimmedInput) as unknown;
    return validateActionPlan(parsedValue);
  } catch {
    // Fall back to extracting a single embedded JSON object from mixed text.
  }

  const candidates = extractJsonObjectCandidates(trimmedInput);

  if (candidates.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_json",
        message: "No valid ActionPlan JSON object was found.",
      },
    };
  }

  if (candidates.length > 1) {
    return {
      ok: false,
      error: {
        code: "multiple_json_objects",
        message: "Multiple JSON objects were found in the response.",
      },
    };
  }

  const candidate = candidates[0];
  if (candidate === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_json",
        message: "No valid ActionPlan JSON object was found.",
      },
    };
  }

  return parseJsonCandidate(candidate);
}
