import { type SessionMode, SessionModeSchema } from "./session.js";

/**
 * Plan mode (feature 2). The `plan-mode` extension reports mode changes with
 * `pi.appendEntry(MODE_ENTRY_TYPE, { mode })`, which reaches the gateway as `entry_appended`
 * (ADR-0007).
 */

export const MODE_ENTRY_TYPE = "cna.mode";

/** `data` of a `cna.mode` custom entry. */
export interface ModeEntryData {
  mode: SessionMode;
}

/** Name of the tool that presents the plan for approval. */
export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

/** Options of a `plan` question (`method: "select"`). The answer is `{ value: <option> }`. */
export const PLAN_ANSWER_OPTIONS = ["approve", "request_changes"] as const;
export type PlanAnswerOption = (typeof PLAN_ANSWER_OPTIONS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the mode from the `entry` of an `entry_appended` event: a custom entry
 * (`type: "custom"`) with `customType: "cna.mode"` and `data: { mode: "plan" | "auto" }`.
 * Anything else → null. Never throws.
 */
export function parseModeEntry(entry: unknown): SessionMode | null {
  if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) {
    return null;
  }
  if (!isRecord(entry.data)) {
    return null;
  }
  const result = SessionModeSchema.safeParse(entry.data.mode);
  return result.success ? result.data : null;
}
