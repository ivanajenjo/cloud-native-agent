import type { SessionStatus } from "@cna/shared";
import { h, text } from "../dom.js";
import type { Component } from "./component.js";
import "./composer.css";

export type SendMode = "steer" | "followUp";

/** Statuses in which the session accepts a message. */
const ACCEPTING: ReadonlySet<SessionStatus> = new Set(["running", "waiting_input", "ready"]);

/** Message box: a form with a textarea, the send mode (while running) and the send button. */
export function createComposer(
  send: (text: string, mode: SendMode) => Promise<void>,
): Component<SessionStatus | null> {
  let status: SessionStatus | null = null;
  let sending = false;

  const errorBox = h("p", { class: "composer-error", attrs: { role: "alert" } });
  errorBox.hidden = true;

  const textarea = h("textarea", {
    class: "composer-text",
    attrs: { placeholder: "Escribe un mensaje…", rows: 3, "aria-label": "Mensaje" },
    on: {
      keydown: (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
          event.preventDefault();
          void submit();
        }
      },
    },
  });

  const mode = h(
    "select",
    { class: "composer-mode", attrs: { "aria-label": "Modo de envío" } },
    h("option", { attrs: { value: "followUp", selected: true }, text: "Al terminar" }),
    h("option", { attrs: { value: "steer" }, text: "Ahora (interrumpe)" }),
  );
  mode.hidden = true;

  const button = h("button", {
    class: "composer-send",
    attrs: { type: "submit" },
    text: "Enviar",
  });

  const form = h(
    "form",
    {
      class: "composer",
      on: {
        submit: (event) => {
          event.preventDefault();
          void submit();
        },
      },
    },
    textarea,
    errorBox,
    h("div", { class: "composer-actions" }, mode, button),
  );

  function showError(message: string): void {
    errorBox.hidden = message === "";
    errorBox.replaceChildren(text(message));
  }

  /** Only the disabled and hidden state change here: the textarea keeps what was typed. */
  function refresh(): void {
    const enabled = status !== null && ACCEPTING.has(status) && !sending;
    textarea.disabled = !enabled;
    button.disabled = !enabled;
    mode.disabled = !enabled;
    mode.hidden = status !== "running";
  }

  async function submit(): Promise<void> {
    const value = textarea.value.trim();
    if (value === "" || sending || status === null || !ACCEPTING.has(status)) {
      return;
    }
    // While running, the select picks steer or followUp; otherwise Pi takes the message as followUp.
    const sendMode: SendMode =
      status === "running" && mode.value === "steer" ? "steer" : "followUp";
    sending = true;
    showError("");
    refresh();
    try {
      await send(value, sendMode);
      textarea.value = "";
      showError("");
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      sending = false;
      refresh();
      if (!textarea.disabled) {
        textarea.focus();
      }
    }
  }

  refresh();

  return {
    element: form,
    update(value) {
      status = value;
      refresh();
    },
  };
}
