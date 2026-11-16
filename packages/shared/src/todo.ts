/**
 * Task list of the agent (feature 1). The `todo` tool of `@cna/extensions` always receives and
 * returns the complete list; the gateway reads it from `details` of `tool_execution_end`
 * (ADR-0007) and emits the `todo` SSE event.
 */

export const TODO_TOOL_NAME = "todo";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** Limits enforced by the `todo` tool. */
export const TODO_LIMITS = { maxItems: 50, maxTextLength: 500 } as const;

export interface TodoItem {
  /** 1-based position in the list. */
  id: number;
  text: string;
  status: TodoStatus;
}

/** `details` of a successful `todo` tool result. */
export interface TodoDetails {
  todos: TodoItem[];
}

/** Body of `GET /session/todos`. */
export interface TodosResponse {
  todos: TodoItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the list from the `details` of a `todo` tool result. Returns null unless `details` is
 * `{ todos: [...] }` and every item has an integer `id` >= 1, a string `text` and a known
 * `status`. Extra fields are dropped. Never throws.
 */
export function parseTodoDetails(details: unknown): TodoItem[] | null {
  if (!isRecord(details) || !Array.isArray(details.todos)) {
    return null;
  }
  const items: TodoItem[] = [];
  for (const raw of details.todos) {
    if (!isRecord(raw)) return null;
    const { id, text, status } = raw;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return null;
    if (typeof text !== "string") return null;
    if (!(TODO_STATUSES as readonly unknown[]).includes(status)) return null;
    items.push({ id, text, status: status as TodoStatus });
  }
  return items;
}
