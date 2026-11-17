import "./diff.css";
import type { Checkpoint, DiffFile, DiffResponse, DiffSource } from "@cna/shared";
import { h, text } from "../dom.js";
import { type PatchFile, type PatchLine, parsePatch } from "../patch.js";
import type { Component } from "./component.js";
import { checkpointReasonLabel, formatClock, shortSha, statusLetter } from "./panels-format.js";

/** Diff lines painted at most; the rest is cut in the view. */
const MAX_VIEW_LINES = 5000;

export interface DiffDeps {
  loadDiff(checkpoint?: number): Promise<DiffResponse>;
  /** Restores the working tree (and the conversation if `conversation`). */
  restore(id: number, conversation: boolean): Promise<void>;
}

export interface DiffPanel extends Component<Checkpoint[]> {
  /** Reloads the diff for the current selection. */
  refresh(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Checkpoints from the most recent to the oldest. */
function newestFirst(checkpoints: Checkpoint[]): Checkpoint[] {
  return [...checkpoints].sort((a, b) => b.id - a.id);
}

function checkpointDescription(checkpoint: Checkpoint): string {
  return `#${checkpoint.id} · ${formatClock(checkpoint.createdAt)} · ${checkpointReasonLabel(checkpoint.reason)}`;
}

function sourceNodes(from: DiffSource): Node[] {
  if (from.kind === "base") {
    return [
      text("Frente a rama base "),
      h("code", { text: from.branch }),
      text(` (${shortSha(from.commit)})`),
    ];
  }
  return [text(`Frente al checkpoint #${from.id} (${shortSha(from.commit)})`)];
}

function fileRow(file: DiffFile): HTMLLIElement {
  const path =
    file.status === "renamed" && file.oldPath !== undefined
      ? `${file.oldPath} → ${file.path}`
      : file.path;
  const stats =
    file.additions === null || file.deletions === null
      ? "binario"
      : `+${file.additions} −${file.deletions}`;
  return h(
    "li",
    { class: "diff-file" },
    h("span", { class: `diff-status diff-status-${file.status}`, text: statusLetter(file.status) }),
    h("span", { class: "diff-path", text: path }),
    h("span", { class: "diff-stats", text: stats }),
  );
}

function lineElement(line: PatchLine): HTMLSpanElement {
  // An empty line would collapse to zero height; a space keeps the row visible.
  return h("span", {
    class: `diff-line diff-${line.kind}`,
    text: line.text === "" ? " " : line.text,
  });
}

function fileDiff(file: PatchFile, lines: PatchLine[]): HTMLDetailsElement {
  return h(
    "details",
    { class: "diff-patch", attrs: { open: true } },
    h("summary", { text: file.path }),
    h("pre", { class: "diff-code" }, ...lines.map(lineElement)),
  );
}

/**
 * Diff panel: compares the working tree with the base branch or with a checkpoint, lists the
 * checkpoints and restores them. It does not load anything by itself; call `refresh()` to load.
 */
export function createDiffPanel(deps: DiffDeps): DiffPanel {
  let checkpoints: Checkpoint[] = [];
  /** Identifies the last diff request; older responses are discarded. */
  let requestSeq = 0;
  let busy = false;
  let restoreButtons: HTMLButtonElement[] = [];

  const select = h("select", { class: "diff-select", on: { change: () => reload() } });
  const conversation = h("input", { attrs: { type: "checkbox" } });
  const messageBox = h("div", { class: "diff-messages", attrs: { "aria-live": "polite" } });
  const result = h("div", { class: "diff-result" });
  const checkpointList = h("ul", { class: "diff-checkpoints" });

  const element = h(
    "div",
    { class: "diff-panel" },
    h(
      "div",
      { class: "diff-toolbar" },
      h("label", { class: "diff-compare" }, text("Comparar con "), select),
      h("button", { attrs: { type: "button" }, on: { click: () => reload() } }, text("Actualizar")),
    ),
    messageBox,
    result,
    h(
      "section",
      { class: "diff-checkpoints-section" },
      h("h3", { text: "Checkpoints" }),
      h("label", { class: "diff-conversation" }, conversation, text(" Incluir la conversación")),
      checkpointList,
    ),
  );

  function showMessage(message: string, isError: boolean): void {
    messageBox.replaceChildren(
      ...(message === ""
        ? []
        : [h("p", { class: isError ? "diff-error" : "diff-loading", text: message })]),
    );
  }

  function selectedCheckpoint(): number | undefined {
    return select.value === "" ? undefined : Number(select.value);
  }

  function renderOptions(): void {
    const previous = select.value;
    const sorted = newestFirst(checkpoints);
    select.replaceChildren(
      h("option", { attrs: { value: "" }, text: "Rama base" }),
      ...sorted.map((checkpoint) =>
        h("option", {
          attrs: { value: String(checkpoint.id) },
          text: `Checkpoint ${checkpointDescription(checkpoint)}`,
        }),
      ),
    );
    select.value = sorted.some((checkpoint) => String(checkpoint.id) === previous) ? previous : "";
  }

  function setBusy(value: boolean): void {
    busy = value;
    for (const button of restoreButtons) {
      button.disabled = value;
    }
  }

  function renderCheckpoints(): void {
    restoreButtons = [];
    const items = newestFirst(checkpoints).map((checkpoint) => {
      const button = h(
        "button",
        {
          attrs: { type: "button", disabled: busy },
          on: {
            click: () => {
              void restore(checkpoint);
            },
          },
        },
        text("Restaurar"),
      );
      restoreButtons.push(button);
      return h(
        "li",
        { class: "diff-checkpoint" },
        h("span", {
          class: "diff-checkpoint-info",
          text: `${checkpointDescription(checkpoint)} · ${shortSha(checkpoint.commit)}`,
        }),
        button,
      );
    });
    if (items.length === 0) {
      items.push(h("li", { class: "diff-empty", text: "Sin checkpoints" }));
    }
    checkpointList.replaceChildren(...items);
  }

  function renderDiff(diff: DiffResponse): void {
    const nodes: Node[] = [h("p", { class: "diff-from" }, ...sourceNodes(diff.from))];

    if (diff.files.length === 0) {
      nodes.push(h("p", { class: "diff-empty", text: "Sin cambios" }));
    } else {
      nodes.push(h("ul", { class: "diff-files" }, ...diff.files.map(fileRow)));
    }
    if (diff.truncated) {
      nodes.push(
        h("p", { class: "diff-note", text: "El servidor recortó el diff (más de 1 MiB)" }),
      );
    }

    const files = parsePatch(diff.patch);
    let total = 0;
    for (const file of files) {
      total += file.lines.length;
    }
    let budget = MAX_VIEW_LINES;
    for (const file of files) {
      if (budget <= 0) {
        break;
      }
      const lines = file.lines.slice(0, budget);
      budget -= lines.length;
      nodes.push(fileDiff(file, lines));
    }
    if (total > MAX_VIEW_LINES) {
      nodes.push(
        h("p", { class: "diff-note", text: "(diff demasiado largo, recortado en la vista)" }),
      );
    }

    result.replaceChildren(...nodes);
  }

  function reload(): void {
    const seq = ++requestSeq;
    result.replaceChildren();
    showMessage("Cargando…", false);
    deps.loadDiff(selectedCheckpoint()).then(
      (diff) => {
        if (seq !== requestSeq) return;
        showMessage("", false);
        renderDiff(diff);
      },
      (error: unknown) => {
        if (seq !== requestSeq) return;
        showMessage(errorMessage(error), true);
      },
    );
  }

  async function restore(checkpoint: Checkpoint): Promise<void> {
    const withConversation = conversation.checked;
    const question = `¿Restaurar el checkpoint #${checkpoint.id}? Se perderán los cambios posteriores del árbol de trabajo${withConversation ? " y de la conversación" : ""}.`;
    if (!window.confirm(question)) {
      return;
    }
    setBusy(true);
    try {
      await deps.restore(checkpoint.id, withConversation);
      reload();
    } catch (error) {
      showMessage(errorMessage(error), true);
    } finally {
      setBusy(false);
    }
  }

  return {
    element,
    update(next: Checkpoint[]): void {
      checkpoints = next;
      renderOptions();
      renderCheckpoints();
    },
    refresh(): void {
      reload();
    },
  };
}
