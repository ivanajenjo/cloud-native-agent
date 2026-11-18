import "./replicas.css";
import type { ReplicaSummary } from "@cna/shared";
import { freeReplicaNames } from "@cna/shared/client";
import { h, text } from "../dom.js";
import { replicaStateLabel } from "./replicas-format.js";

export interface ReplicasDeps {
  /** GET /replicas (edge order: the first one is the default replica). */
  load(): Promise<ReplicaSummary[]>;
  /** Navigates to that replica (the caller changes the URL fragment). */
  open(name: string): void;
  /** Name of the replica this page follows; null = the default one (the first of the list). */
  current: string | null;
}

export interface ReplicasPanel {
  readonly element: HTMLElement;
  /** Reloads the list. */
  refresh(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** All replicas and their sessions (ADR-0013). Loads nothing by itself: call refresh(). */
export function createReplicasPanel(deps: ReplicasDeps): ReplicasPanel {
  /** Identifies the last list request; older responses are discarded. */
  let loadSeq = 0;
  let loading = false;
  /** Last loaded list; null while loading or after a failed load. */
  let replicas: ReplicaSummary[] | null = null;

  const messageBox = h("div", { class: "replicas-messages", attrs: { "aria-live": "polite" } });
  const list = h("ul", { class: "replicas-list" });

  const refreshButton = h("button", {
    class: "replicas-button",
    attrs: { type: "button" },
    on: {
      click: () => {
        refresh();
      },
    },
    text: "Actualizar",
  });

  const freeButton = h("button", {
    class: "replicas-button",
    attrs: { type: "button", disabled: true },
    on: {
      click: () => {
        const [first] = freeReplicaNames(replicas ?? []);
        if (first !== undefined) {
          deps.open(first);
        }
      },
    },
    text: "Nueva sesión en una réplica libre",
  });

  const freeNote = h("p", {
    class: "replicas-free-note",
    attrs: { hidden: true },
    text: "No hay ninguna réplica libre",
  });

  const element = h(
    "section",
    { class: "replicas-panel" },
    h("h2", { class: "replicas-title", text: "Réplicas" }),
    messageBox,
    h("div", { class: "replicas-actions" }, refreshButton, freeButton),
    freeNote,
    list,
  );

  function showMessage(message: string, isError: boolean): void {
    messageBox.replaceChildren(
      ...(message === ""
        ? []
        : [
            h("p", {
              class: isError ? "replicas-error" : "replicas-loading",
              text: message,
            }),
          ]),
    );
  }

  /** Enables the "new session" button only when the list is loaded and has a free replica. */
  function updateActions(): void {
    const free = replicas === null ? [] : freeReplicaNames(replicas);
    freeButton.disabled = loading || replicas === null || free.length === 0;
    freeNote.hidden = loading || replicas === null || free.length > 0;
  }

  function replicaItem(
    replica: ReplicaSummary,
    isDefault: boolean,
    current: string | null,
  ): HTMLLIElement {
    const { session } = replica;
    const isCurrent = replica.name === current;
    const stateClass =
      session === null ? "replicas-state" : `replicas-state status-${session.status}`;

    const children: Node[] = [
      h(
        "div",
        { class: "replicas-head" },
        h(
          "strong",
          { class: "replicas-name" },
          text(replica.name),
          isDefault ? text(" (por defecto)") : null,
        ),
        h("span", { class: stateClass, text: replicaStateLabel(replica) }),
      ),
    ];

    if (session !== null && session.status !== "closed") {
      const prLabel = session.pr === null ? "" : ` · PR #${session.pr}`;
      children.push(
        h("div", { class: "replicas-meta", text: `${session.repo}${prLabel}` }),
        h(
          "div",
          { class: "replicas-meta" },
          text(`Rama ${session.branch ?? "—"}`),
          session.suspended ? text(" · ") : null,
          session.suspended ? h("span", { class: "replicas-paused", text: "en pausa" }) : null,
        ),
      );
    }

    children.push(
      isCurrent
        ? h("button", {
            class: "replicas-button replicas-open",
            attrs: { type: "button", disabled: true },
            text: "Actual",
          })
        : h("button", {
            class: "replicas-button replicas-open",
            attrs: { type: "button" },
            on: {
              click: () => {
                deps.open(replica.name);
              },
            },
            text: "Abrir",
          }),
    );

    return h(
      "li",
      {
        class: "replicas-item",
        attrs: { "aria-current": isCurrent ? "true" : undefined },
      },
      ...children,
    );
  }

  function render(entries: ReplicaSummary[]): void {
    if (entries.length === 0) {
      list.replaceChildren(h("li", { class: "replicas-empty", text: "No hay réplicas" }));
      return;
    }
    const current = deps.current ?? entries[0]?.name ?? null;
    list.replaceChildren(
      ...entries.map((replica, index) => replicaItem(replica, index === 0, current)),
    );
  }

  function refresh(): void {
    const seq = ++loadSeq;
    loading = true;
    replicas = null;
    list.replaceChildren();
    showMessage("Cargando…", false);
    updateActions();
    deps.load().then(
      (loaded) => {
        if (seq !== loadSeq) return;
        loading = false;
        replicas = loaded;
        showMessage("", false);
        render(loaded);
        updateActions();
      },
      (error: unknown) => {
        if (seq !== loadSeq) return;
        loading = false;
        replicas = null;
        list.replaceChildren();
        showMessage(errorMessage(error), true);
        updateActions();
      },
    );
  }

  return { element, refresh };
}
