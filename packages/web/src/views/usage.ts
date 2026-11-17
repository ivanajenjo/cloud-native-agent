import "./usage.css";
import type { SessionStats } from "@cna/shared";
import { h, text } from "../dom.js";
import { formatCost, formatTokens } from "./usage-format.js";

export interface UsagePanel {
  readonly element: HTMLElement;
  /** Reloads the stats. */
  refresh(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Context window usage as text and a bar; the cases without numbers are explained in words. */
function contextNodes(stats: SessionStats): Node[] {
  const context = stats.context;
  if (context === null) {
    return [text("desconocido")];
  }
  if (context.tokens === null || context.percent === null) {
    return [text("recién compactado")];
  }
  return [
    h("progress", {
      class: "usage-progress",
      attrs: { max: 100, value: context.percent },
    }),
    text(
      ` ${formatTokens(context.tokens)} de ${formatTokens(context.window)} (${Math.round(context.percent)} %)`,
    ),
  ];
}

/** One label and its value, as a pair of `dt` and `dd`. */
function row(label: string, ...value: Node[]): Node[] {
  return [h("dt", { text: label }), h("dd", {}, ...value)];
}

/**
 * Usage panel: cost, tokens, messages and context window of the session (feature 9). It does not
 * load anything by itself; call `refresh()` to load.
 */
export function createUsagePanel(loadStats: () => Promise<SessionStats>): UsagePanel {
  /** Identifies the last stats request; older responses are discarded. */
  let loadSeq = 0;

  const messageBox = h("div", { class: "usage-messages", attrs: { "aria-live": "polite" } });
  const body = h("dl", { class: "usage-grid" });

  const element = h(
    "section",
    { class: "usage-panel" },
    h("h2", { class: "usage-title", text: "Uso de la sesión" }),
    messageBox,
    body,
    h(
      "button",
      {
        class: "usage-refresh",
        attrs: { type: "button" },
        on: { click: () => refresh() },
      },
      text("Actualizar"),
    ),
  );

  function showMessage(message: string, isError: boolean): void {
    messageBox.replaceChildren(
      ...(message === ""
        ? []
        : [h("p", { class: isError ? "usage-error" : "usage-loading", text: message })]),
    );
  }

  function render(stats: SessionStats): void {
    const { tokens, messages } = stats;
    body.replaceChildren(
      ...row("Coste", text(formatCost(stats.cost))),
      ...row(
        "Tokens",
        text(formatTokens(tokens.total)),
        h(
          "span",
          { class: "usage-breakdown" },
          text(
            `entrada ${formatTokens(tokens.input)} / salida ${formatTokens(tokens.output)} / caché leída ${formatTokens(tokens.cacheRead)} / caché escrita ${formatTokens(tokens.cacheWrite)}`,
          ),
        ),
      ),
      ...row(
        "Mensajes",
        text(
          `usuario ${messages.user} / asistente ${messages.assistant} / llamadas a tools ${messages.toolCalls}`,
        ),
      ),
      ...row("Contexto", ...contextNodes(stats)),
    );
  }

  function refresh(): void {
    const seq = ++loadSeq;
    body.replaceChildren();
    showMessage("Cargando…", false);
    loadStats().then(
      (stats) => {
        if (seq !== loadSeq) return;
        showMessage("", false);
        render(stats);
      },
      (error: unknown) => {
        if (seq !== loadSeq) return;
        showMessage(errorMessage(error), true);
      },
    );
  }

  return { element, refresh };
}
