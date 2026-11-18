import type { SessionInfo } from "@cna/shared";
import { h } from "../dom.js";
import type { Component } from "./component.js";
import { statusLabel } from "./format.js";
import "./header.css";

export interface HeaderActions {
  abort(): void;
  close(): void;
  logout(): void;
}

/**
 * Header with the title, the session summary and the session actions. `extra` (e.g. the replica
 * selector) goes in the top row, between the title and the actions; it is always the same node.
 */
export function createHeader(
  actions: HeaderActions,
  extra?: HTMLElement,
): Component<SessionInfo | null> {
  const root = h("header", { class: "header" });

  function build(session: SessionInfo | null): HTMLElement[] {
    const title = h("h1", { class: "header-title", text: "cna" });
    const logout = h("button", {
      class: "header-button",
      attrs: { type: "button" },
      on: { click: () => actions.logout() },
      text: "Salir",
    });

    if (session === null) {
      return [
        h(
          "div",
          { class: "header-top" },
          title,
          extra,
          h("div", { class: "header-actions" }, logout),
        ),
      ];
    }

    const canAbort = session.status === "running" || session.status === "waiting_input";
    const canClose = session.status !== "closed";
    const abort = h("button", {
      class: "header-button",
      attrs: { type: "button", disabled: !canAbort },
      on: { click: () => actions.abort() },
      text: "Abortar",
    });
    const close = h("button", {
      class: "header-button",
      attrs: { type: "button", disabled: !canClose },
      on: { click: () => actions.close() },
      text: "Cerrar sesión",
    });

    const details = h(
      "dl",
      { class: "header-details" },
      h("dt", { text: "Repo" }),
      h("dd", { class: "header-repo", text: session.repo }),
      h("dt", { text: "Rama" }),
      h("dd", { class: "header-branch", text: session.branch ?? "—" }),
      ...(session.pr === null
        ? []
        : [h("dt", { text: "PR" }), h("dd", { class: "header-pr", text: `#${session.pr}` })]),
      h("dt", { text: "Estado" }),
      h(
        "dd",
        { class: "header-state" },
        h("span", {
          class: `header-status status-${session.status}`,
          text: statusLabel(session.status),
        }),
        session.suspended
          ? h("span", {
              class: "header-suspended",
              attrs: {
                title: "Pi está parado por inactividad; arrancará con el siguiente mensaje",
              },
              text: "en pausa",
            })
          : null,
      ),
      h("dt", { text: "Modelo" }),
      h("dd", { class: "header-model", text: session.model ?? "modelo por defecto" }),
      h("dt", { text: "Modo" }),
      h("dd", { class: "header-mode", text: session.mode }),
    );

    return [
      h(
        "div",
        { class: "header-top" },
        title,
        extra,
        h("div", { class: "header-actions" }, abort, close, logout),
      ),
      details,
      ...(session.error
        ? [
            h("p", {
              class: "header-error",
              attrs: { role: "alert" },
              text: `Error: ${session.error}`,
            }),
          ]
        : []),
    ];
  }

  return {
    element: root,
    update(session: SessionInfo | null): void {
      root.replaceChildren(...build(session));
    },
  };
}
