import type { TodoItem, TodoStatus } from "@cna/shared";
import { h } from "../dom.js";
import type { Component } from "./component.js";
import "./todos.css";

const MARKERS: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "◐",
  completed: "☑",
};

const SR_LABELS: Record<TodoStatus, string> = {
  pending: "pendiente",
  in_progress: "en curso",
  completed: "completada",
};

/** Checklist of the agent's tasks. */
export function createTodosPanel(): Component<TodoItem[]> {
  const root = h("section", { class: "todos", attrs: { "aria-label": "Tareas" } });

  function build(todos: TodoItem[]): HTMLElement[] {
    const title = h("h2", { class: "todos-title", text: "Tareas" });
    if (todos.length === 0) {
      return [title, h("p", { class: "todos-empty", text: "Sin tareas" })];
    }
    const items = todos.map((todo) =>
      h(
        "li",
        { class: `todos-item todo-${todo.status}` },
        h("span", {
          class: "todos-marker",
          attrs: { "aria-hidden": "true" },
          text: MARKERS[todo.status],
        }),
        h("span", { class: "todos-sr", text: `(${SR_LABELS[todo.status]}) ` }),
        h("span", { class: "todos-text", text: todo.text }),
      ),
    );
    return [title, h("ul", { class: "todos-list" }, ...items)];
  }

  return {
    element: root,
    update(todos: TodoItem[]): void {
      root.replaceChildren(...build(todos));
    },
  };
}
