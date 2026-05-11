import type { ActionPlan, ValidationResult } from "./actionPlan.js";

export type AgentTaskStatus =
  | "idle"
  | "planning"
  | "waiting_for_approval"
  | "executing"
  | "completed"
  | "failed";

export interface AgentTask {
  id: string;
  userInstruction: string;
  model: string;
  status: AgentTaskStatus;
  actionPlan?: ActionPlan;
  validationResult?: ValidationResult;
  createdAt: string;
  updatedAt: string;
}
