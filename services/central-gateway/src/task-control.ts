// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
export const TASK_CONTROL_MARKER = "yuan-zhou-plan-goal/1";
export type CollaborationMode = "default" | "plan";
export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** User mode selection cannot carry arbitrary developer instructions. */
export function collaborationMode(value: unknown): CollaborationMode | undefined {
  if (value === undefined) return;
  if (!object(value) || !["default", "plan"].includes(String(value.mode))
    || Object.keys(value).some(k => !["mode", "settings"].includes(k)) || !object(value.settings)
    || Object.keys(value.settings).some(k => !["model", "reasoning_effort", "developer_instructions"].includes(k))
    || typeof value.settings.model !== "string" || !value.settings.model.trim()
    || value.settings.developer_instructions !== null
    || (value.settings.reasoning_effort !== null && typeof value.settings.reasoning_effort !== "string")) {
    throw Error("COLLABORATION_MODE_INVALID: select a built-in mode and an available model");
  }
  return value.mode as CollaborationMode;
}

export function goalParams(payload: Record<string, unknown>, operation: "get" | "set" | "clear") {
  const allowed = operation === "set" ? ["threadId", "objective", "status", "tokenBudget"] : ["threadId"];
  if (Object.keys(payload).some(k => !allowed.includes(k)) || typeof payload.threadId !== "string" || !payload.threadId) throw Error("GOAL_INPUT_INVALID");
  if (operation === "set") {
    if (payload.objective !== undefined && (typeof payload.objective !== "string" || !payload.objective.trim() || [...payload.objective].length > 4000)) throw Error("GOAL_OBJECTIVE_INVALID");
    // Completion belongs to the model's evidence audit, not a client checkbox.
    if (payload.status !== undefined && !["active", "paused"].includes(String(payload.status))) throw Error("GOAL_STATUS_INVALID");
    if (payload.tokenBudget !== undefined && payload.tokenBudget !== null && (!Number.isSafeInteger(payload.tokenBudget) || Number(payload.tokenBudget) <= 0)) throw Error("GOAL_BUDGET_INVALID");
    if (!["objective", "status", "tokenBudget"].some(k => k in payload)) throw Error("GOAL_INPUT_INVALID");
  }
  return payload;
}

export function planToolAllowed(tool: string): boolean {
  return ["device_workspace_list", "device_read_file", "device_read_text", "device_workspace_context", "device_workspace_search",
    "device_workspace_read_text", "device_workspace_git_status", "device_workspace_git_diff", "conversation_read"].includes(tool);
}
