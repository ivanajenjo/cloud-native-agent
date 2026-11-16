/**
 * Extension `todo`: keeps a visible task list of the agent. Each call receives the complete
 * list, which replaces the previous one. The gateway reads the list from `details` of the
 * `tool_execution_end` event (ADR-0007) and emits the `todo` SSE event.
 */

import {
  TODO_LIMITS,
  TODO_STATUSES,
  TODO_TOOL_NAME,
  type TodoDetails,
  type TodoItem,
  type TodoStatus,
} from "@cna/shared";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATUS_MARKS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

const parameters = Type.Object({
  todos: Type.Array(
    Type.Object({
      text: Type.String({ description: "What the task is about, in one short sentence." }),
      status: StringEnum(TODO_STATUSES, {
        description:
          "pending: not started; in_progress: being worked on now (at most one); completed: done.",
      }),
    }),
    {
      description:
        "The complete task list, in order. It replaces the previous list; an empty list clears it.",
    },
  ),
});

/**
 * Validates the list the model sent. Pi validates the JSON Schema, but not the limits, the
 * empty texts or the status values, so they are checked here. Throws on the first problem.
 */
function validateTodos(todos: { text: string; status: unknown }[]): TodoItem[] {
  if (todos.length > TODO_LIMITS.maxItems) {
    throw new Error(
      `The task list has ${todos.length} items; the maximum is ${TODO_LIMITS.maxItems}.`,
    );
  }

  const items: TodoItem[] = [];
  let inProgress = 0;
  todos.forEach((todo, index) => {
    const position = index + 1;
    const text = todo.text.trim();
    if (text === "") {
      throw new Error(`Task ${position} has an empty text.`);
    }
    if (text.length > TODO_LIMITS.maxTextLength) {
      throw new Error(
        `Task ${position} is ${text.length} characters long; the maximum is ${TODO_LIMITS.maxTextLength}.`,
      );
    }
    if (!(TODO_STATUSES as readonly unknown[]).includes(todo.status)) {
      throw new Error(
        `Task ${position} has an unknown status "${String(todo.status)}"; use one of: ${TODO_STATUSES.join(", ")}.`,
      );
    }
    const status = todo.status as TodoStatus;
    if (status === "in_progress") {
      inProgress += 1;
    }
    items.push({ id: position, text, status });
  });

  if (inProgress > 1) {
    throw new Error(`Only one task can be in_progress; found ${inProgress}.`);
  }
  return items;
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "Task list cleared.";
  }
  return todos.map((todo) => `${STATUS_MARKS[todo.status]} ${todo.id}. ${todo.text}`).join("\n");
}

export default function todoExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TODO_TOOL_NAME,
    label: "Todo",
    description:
      "Maintain the visible task list of the agent. Every call receives the complete list, " +
      "which replaces the previous one; an empty list clears it. At most one item may be " +
      "in_progress at a time.",
    promptGuidelines: [
      "Use todo to track multi-step work: send the complete list every time, with at most one item in_progress.",
      "Use todo to mark each item completed as soon as it is done.",
    ],
    parameters,
    async execute(_toolCallId, params) {
      const todos = validateTodos(params.todos);
      const details = { todos } satisfies TodoDetails;
      return { content: [{ type: "text", text: formatTodos(todos) }], details };
    },
  });
}
