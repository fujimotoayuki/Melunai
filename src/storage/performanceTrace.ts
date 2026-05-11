/**
 * Performance Trace helpers — TASK-040 (Workbench v2 §34).
 *
 * Build and write `performance_trace` JSONL events from main.ts and from any
 * code path that calls Ollama. The goal is to make latency auditable:
 *
 *   • Was the model actually called?
 *   • How many characters / estimated tokens did we send?
 *   • How many context files / tree entries were included?
 *   • Did a Timeout Fallback fire?
 *
 * These functions never throw — logging failures must not break the main flow.
 */

import { writeJsonlEvent } from "./jsonlLogger.js";
import type { PerformanceTraceLogEvent } from "./jsonlLogger.js";

/** Crude token estimate (chars / 4 — close enough for budget alarms). */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

/** Sum total prompt characters across an OllamaChatMessage[]. */
export function chatMessagesChars(
  messages: ReadonlyArray<{ content: string }>,
): number {
  let total = 0;
  for (const m of messages) total += m.content.length;
  return total;
}

export type TraceFields = Omit<PerformanceTraceLogEvent, "type" | "sessionId" | "workspaceRoot">;

/** Append a performance_trace event. Swallows write errors. */
export async function recordPerformanceTrace(
  logFilePath: string | null,
  sessionId: string | undefined,
  workspaceRoot: string | undefined,
  fields: TraceFields,
): Promise<void> {
  if (logFilePath === null) return; // no workspace = no log file

  const event: PerformanceTraceLogEvent = {
    type: "performance_trace",
    sessionId,
    workspaceRoot,
    ...fields,
  };

  try {
    await writeJsonlEvent(logFilePath, event);
  } catch {
    // Trace logging must never crash the caller.
  }
}

/**
 * Convenience wrapper: time a function and write a performance_trace.
 *
 * The function is given a mutable bag it can fill with input-size /
 * context-file / fallback fields as the work progresses, so the trace can
 * still be written on either the success or failure path.
 */
export interface TraceBag {
  llmCalled?: boolean;
  model?: string | null;
  inputChars?: number;
  contextFileCount?: number;
  workspaceTreeEntries?: number;
  fallbackUsed?: boolean;
  fallbackKind?: string | null;
  stageTimings?: TraceFields["stageTimings"];
  chunksUsed?: number;
  cacheHit?: boolean;
  errorCode?: string | null;
}

export async function withPerformanceTrace<T>(
  args: {
    route: string;
    logFilePath: string | null;
    sessionId?: string;
    workspaceRoot?: string;
  },
  work: (bag: TraceBag) => Promise<{ success: boolean; result: T }>,
): Promise<T> {
  const start = Date.now();
  const bag: TraceBag = {};

  let outcome: { success: boolean; result: T };
  try {
    outcome = await work(bag);
  } catch (error) {
    const elapsedMs = Date.now() - start;
    await recordPerformanceTrace(args.logFilePath, args.sessionId, args.workspaceRoot, {
      route: args.route,
      llmCalled: bag.llmCalled ?? false,
      model: bag.model ?? null,
      inputChars: bag.inputChars ?? 0,
      estimatedInputTokens: estimateTokens(bag.inputChars ?? 0),
      contextFileCount: bag.contextFileCount ?? 0,
      workspaceTreeEntries: bag.workspaceTreeEntries ?? 0,
      elapsedMs,
      success: false,
      errorCode: bag.errorCode ?? "exception",
      fallbackUsed: bag.fallbackUsed ?? false,
      fallbackKind: bag.fallbackKind ?? null,
      stageTimings: bag.stageTimings,
      chunksUsed: bag.chunksUsed,
      cacheHit: bag.cacheHit,
    });
    throw error;
  }

  const elapsedMs = Date.now() - start;
  await recordPerformanceTrace(args.logFilePath, args.sessionId, args.workspaceRoot, {
    route: args.route,
    llmCalled: bag.llmCalled ?? false,
    model: bag.model ?? null,
    inputChars: bag.inputChars ?? 0,
    estimatedInputTokens: estimateTokens(bag.inputChars ?? 0),
    contextFileCount: bag.contextFileCount ?? 0,
    workspaceTreeEntries: bag.workspaceTreeEntries ?? 0,
    elapsedMs,
    success: outcome.success,
    errorCode: outcome.success ? null : (bag.errorCode ?? "unknown"),
    fallbackUsed: bag.fallbackUsed ?? false,
    fallbackKind: bag.fallbackKind ?? null,
    stageTimings: bag.stageTimings,
    chunksUsed: bag.chunksUsed,
    cacheHit: bag.cacheHit,
  });
  return outcome.result;
}
