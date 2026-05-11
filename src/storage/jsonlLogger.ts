import fs from "node:fs/promises";
import path from "node:path";

import type { ActionPlan, ToolResult, ValidationResult } from "../types/index.js";

export type LogEventType =
  | "user_instruction"
  | "model_selected"
  | "action_plan"
  | "validation_result"
  | "execution_result"
  | "error"
  | "performance_trace";

interface BaseLogEvent {
  type: LogEventType;
  sessionId?: string;
  workspaceRoot?: string;
}

export interface UserInstructionLogEvent extends BaseLogEvent {
  type: "user_instruction";
  userInstruction: string;
}

export interface ModelSelectedLogEvent extends BaseLogEvent {
  type: "model_selected";
  model: string;
}

export interface ActionPlanLogEvent extends BaseLogEvent {
  type: "action_plan";
  actionPlan: ActionPlan;
}

export interface ValidationResultLogEvent extends BaseLogEvent {
  type: "validation_result";
  validationResult: ValidationResult;
}

export interface ExecutionResultLogEvent extends BaseLogEvent {
  type: "execution_result";
  executionResult: unknown;
}

export interface ErrorLogEvent extends BaseLogEvent {
  type: "error";
  error: {
    code: string;
    message: string;
    cause?: unknown;
  };
}

/**
 * PerformanceTrace — every LLM call (and every local fast-path that bypasses
 * the LLM) appends one of these events. Lets the team answer:
 *   "is the latency from the model, or from the app?"
 *
 * Required fields are dictated by Melunai Local Agent Workbench v2 §34.
 */
export interface PerformanceTraceLogEvent extends BaseLogEvent {
  type: "performance_trace";
  /** Logical route — "chat", "plan_action", "local_action", "instant_reply", etc. */
  route: string;
  /** True when Ollama was actually called. */
  llmCalled: boolean;
  /** Model name when llmCalled, else null. */
  model: string | null;
  /** Total characters of all messages sent to Ollama (system + user + previews). 0 when llmCalled === false. */
  inputChars: number;
  /** Crude token estimate (inputChars / 4). 0 when llmCalled === false. */
  estimatedInputTokens: number;
  /** Number of file/document previews actually included in the prompt. */
  contextFileCount: number;
  /** Number of file-tree entries serialized into the prompt (0 for chat fast-path). */
  workspaceTreeEntries: number;
  /** End-to-end milliseconds for this route. */
  elapsedMs: number;
  /** True for ok results, false for any error path. */
  success: boolean;
  /** Error code when success === false. */
  errorCode?: string | null;
  /** True when a Timeout Fallback Controller fallback was used. */
  fallbackUsed: boolean;
  /** Which fallback step ran ("light_prompt" | "no_reference" | "clarification" | "template"). */
  fallbackKind?: string | null;
  /** Optional per-stage breakdown when available. */
  stageTimings?: {
    routeMs?: number;
    promptBuildMs?: number;
    llmMs?: number;
    indexMs?: number;
    extractMs?: number;
    retrievalMs?: number;
  };
  /** Optional retrieval-related counters for future RAG work. */
  chunksUsed?: number;
  cacheHit?: boolean;
}

export type LogEvent =
  | UserInstructionLogEvent
  | ModelSelectedLogEvent
  | ActionPlanLogEvent
  | ValidationResultLogEvent
  | ExecutionResultLogEvent
  | ErrorLogEvent
  | PerformanceTraceLogEvent;

export type LoggedEvent = LogEvent & {
  timestamp: string;
};

export interface JsonlLoggerOptions {
  now?: () => Date;
}

export interface JsonlLogger {
  log(event: LogEvent): Promise<ToolResult<LoggedEvent>>;
}

export function createJsonlLogger(
  logFilePath: string,
  options: JsonlLoggerOptions = {},
): JsonlLogger {
  return {
    log: (event) => writeJsonlEvent(logFilePath, event, options),
  };
}

export async function writeJsonlEvent(
  logFilePath: string,
  event: LogEvent,
  options: JsonlLoggerOptions = {},
): Promise<ToolResult<LoggedEvent>> {
  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const loggedEvent = { ...event, timestamp };

  let line: string;
  try {
    line = `${JSON.stringify(sanitizeForJson(loggedEvent))}\n`;
  } catch (cause) {
    return fail("log_serialization_failed", "Failed to serialize log event.", cause);
  }

  try {
    await fs.mkdir(path.dirname(logFilePath), { recursive: true });
    await fs.appendFile(logFilePath, line, "utf8");
  } catch (cause) {
    return fail("log_write_failed", "Failed to write log event.", cause);
  }

  return {
    ok: true,
    data: loggedEvent,
  };
}

function fail(code: string, message: string, cause?: unknown): ToolResult<LoggedEvent> {
  return {
    ok: false,
    error: { code, message, cause },
  };
}

function sanitizeForJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof nestedValue !== "undefined") {
      output[key] = sanitizeForJson(nestedValue, seen);
    }
  }
  return output;
}
