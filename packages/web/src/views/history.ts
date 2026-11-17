import "./history.css";
import type { HistoryEntry } from "@cna/shared";
import { h, text } from "../dom.js";
import { statusLabel } from "./format.js";
import { formatCost, formatDateTime, formatTokens } from "./usage-format.js";

export interface HistoryDeps {
  loadHistory(): Promise<HistoryEntry[]>;
  /** Resumes a closed session; rejects with an Error whose message is shown. */
  resume(id: string): Promise<void>;
}

export interface HistoryPanel {
  readonly element: HTMLElement;
  /** Reloads the history. */
  refresh(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Label of the state: the current session (no `closedAt`) is "actual", the others their status. */
function stateLabel(entry: HistoryEntry): string {
  return entry.closedAt === null ? "actual" : statusLabel(entry.status);
}

/**
 * History panel: the sessions of this replica, newest first, with cost and tokens, and a
 * "Retomar" button on the closed ones that can be resumed. It does not load anything by itself;
 * call `refresh()` to load.
 */
export function createHistoryPanel(deps: HistoryDeps): HistoryPanel {
  /** Identifies the last history request; older responses are discarded. */
  let loadSeq = 0;
  let busy = false;
  let resumeButtons: HTMLButtonElement[] = [];

  const messageBox = h("div", { class: "history-messages", attrs: { "aria-live": "polite" } });
  const list = h("ul", { class: "history-list" });

  const element = h(
    "section",
    { class: "history-panel" },
    h("h2", { class: "history-title", text: "Sesiones anteriores" }),
    messageBox,
    list,
  );

  function showMessage(message: string, isError: boolean): void {
    messageBox.replaceChildren(
      ...(message === ""
        ? []
        : [h("p", { class: isError ? "history-error" : "history-loading", text: message })]),
    );
  }

  function setBusy(value: boolean): void {
    busy = value;
    for (const button of resumeButtons) {
      button.disabled = value;
    }
  }

  async function resume(entry: HistoryEntry): Promise<void> {
    const question = `¿Retomar la sesión de ${entry.repo} en ${entry.branch ?? "—"}? Se clonará de nuevo el repo.`;
    if (!window.confirm(question)) {
      return;
    }
    setBusy(true);
    try {
      await deps.resume(entry.id);
      busy = false;
      // The resumed session is now the current one: reload the list so it shows as "actual".
      refresh();
    } catch (error) {
      showMessage(errorMessage(error), true);
      setBusy(false);
    }
  }

  function entryItem(entry: HistoryEntry): HTMLLIElement {
    const prLabel = entry.pr === null ? "" : ` · PR #${entry.pr}`;
    const cost = entry.stats === null ? "—" : formatCost(entry.stats.cost);
    const tokens = entry.stats === null ? "—" : formatTokens(entry.stats.tokens.total);
    const children: Node[] = [
      h(
        "div",
        { class: "history-head" },
        h("strong", { class: "history-repo", text: `${entry.repo}${prLabel}` }),
        h("span", { class: "history-state", text: stateLabel(entry) }),
      ),
      h("div", {
        class: "history-meta",
        text: `Rama ${entry.branch ?? "—"}`,
      }),
      h("div", {
        class: "history-meta",
        text: `Creada ${formatDateTime(entry.createdAt)} · Cerrada ${entry.closedAt === null ? "—" : formatDateTime(entry.closedAt)}`,
      }),
      h("div", { class: "history-meta", text: `Coste ${cost} · Tokens ${tokens}` }),
    ];
    if (entry.resumable) {
      const button = h(
        "button",
        {
          class: "history-resume",
          attrs: { type: "button", disabled: busy },
          on: {
            click: () => {
              void resume(entry);
            },
          },
        },
        text("Retomar"),
      );
      resumeButtons.push(button);
      children.push(button);
    }
    return h("li", { class: "history-item" }, ...children);
  }

  function render(entries: HistoryEntry[]): void {
    resumeButtons = [];
    if (entries.length === 0) {
      list.replaceChildren(h("li", { class: "history-empty", text: "Todavía no hay sesiones" }));
      return;
    }
    list.replaceChildren(...entries.map(entryItem));
  }

  function refresh(): void {
    const seq = ++loadSeq;
    list.replaceChildren();
    showMessage("Cargando…", false);
    deps.loadHistory().then(
      (entries) => {
        if (seq !== loadSeq) return;
        showMessage("", false);
        render(entries);
      },
      (error: unknown) => {
        if (seq !== loadSeq) return;
        showMessage(errorMessage(error), true);
      },
    );
  }

  return { element, refresh };
}
