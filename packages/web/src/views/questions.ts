import type { AnswerRequest, Question } from "@cna/shared";
import { optionLabel } from "@cna/shared/client";
import { type Child, h, text } from "../dom.js";
import type { Component } from "./component.js";
import { expiryTime } from "./text.js";
import "./questions.css";

type Control = HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement;

interface Card {
  element: HTMLElement;
}

/** Pending questions. Answering keeps the card until `question_resolved` removes it. */
export function createQuestionsPanel(
  answer: (id: string, body: AnswerRequest) => Promise<void>,
): Component<Question[]> {
  /** Cards by question id: an existing card is kept as it is (what was typed stays). */
  let cards = new Map<string, Card>();
  const element = h("section", { class: "questions" });
  element.hidden = true;

  return {
    element,
    update(questions) {
      const next = new Map<string, Card>();
      const nodes: HTMLElement[] = [];
      for (const question of questions) {
        let card = cards.get(question.id);
        if (!card) {
          card = createCard(question, (body) => answer(question.id, body));
        }
        next.set(question.id, card);
        nodes.push(card.element);
      }
      cards = next;
      element.replaceChildren(...nodes);
      element.hidden = nodes.length === 0;
    },
  };
}

function headerText(question: Question): string {
  switch (question.kind) {
    case "ask_user":
      return "Pregunta del agente";
    case "confirm":
      return "Confirmación";
    case "plan":
      return "Plan";
    case "network":
      return question.network ? `Red: ${question.network.host}:${question.network.port}` : "Red";
  }
}

function createCard(question: Question, answer: (body: AnswerRequest) => Promise<void>): Card {
  /** Every control of the card, disabled while an answer is being sent. */
  const controls: Control[] = [];
  const errorBox = h("p", { class: "question-error", attrs: { role: "alert" } });
  errorBox.hidden = true;
  let busy = false;

  function showError(message: string): void {
    errorBox.hidden = message === "";
    errorBox.replaceChildren(text(message));
  }

  function setBusy(value: boolean): void {
    busy = value;
    for (const control of controls) {
      control.disabled = value;
    }
  }

  async function submit(body: AnswerRequest): Promise<void> {
    if (busy) {
      return;
    }
    showError("");
    setBusy(true);
    try {
      await answer(body);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  /** A button whose answer is computed at click time (the input may have changed). */
  function button(
    label: string,
    className: string,
    answerBody: () => AnswerRequest,
  ): HTMLButtonElement {
    const created = h("button", {
      class: className,
      attrs: { type: "button" },
      text: label,
      on: { click: () => void submit(answerBody()) },
    });
    controls.push(created);
    return created;
  }

  const fixed = (body: AnswerRequest) => (): AnswerRequest => body;

  const children: Child[] = [];
  children.push(h("div", { class: "question-header", text: headerText(question) }));
  if (question.kind === "plan") {
    children.push(h("pre", { class: "question-plan", text: question.title }));
  } else {
    children.push(h("p", { class: "question-title", text: question.title }));
  }
  if (question.message) {
    children.push(h("p", { class: "question-message", text: question.message }));
  }
  if (question.timeoutMs !== undefined) {
    const expiry = expiryTime(question.createdAt, question.timeoutMs);
    if (expiry !== "") {
      children.push(h("p", { class: "question-expiry", text: `Caduca a las ${expiry}` }));
    }
  }

  const actions: HTMLButtonElement[] = [];
  switch (question.method) {
    case "select":
      for (const option of question.options ?? []) {
        actions.push(
          button(optionLabel(question, option), "question-btn", fixed({ value: option })),
        );
      }
      break;
    case "confirm":
      actions.push(
        button("Sí", "question-btn question-btn-primary", fixed({ confirmed: true })),
        button("No", "question-btn", fixed({ confirmed: false })),
      );
      break;
    case "input": {
      const input = h("input", {
        class: "question-input",
        attrs: { type: "text", placeholder: question.placeholder ?? "" },
        on: {
          keydown: (event) => {
            if (event.key === "Enter" && !event.isComposing) {
              event.preventDefault();
              void submit({ value: input.value });
            }
          },
        },
      });
      controls.push(input);
      children.push(input);
      actions.push(
        button("Enviar", "question-btn question-btn-primary", () => ({ value: input.value })),
      );
      break;
    }
    case "editor": {
      const editor = h("textarea", { class: "question-editor" });
      editor.value = question.prefill ?? "";
      controls.push(editor);
      children.push(editor);
      actions.push(
        button("Enviar", "question-btn question-btn-primary", () => ({ value: editor.value })),
      );
      break;
    }
  }
  actions.push(button("Cancelar", "question-btn question-cancel", fixed({ cancelled: true })));

  children.push(h("div", { class: "question-actions" }, ...actions));
  children.push(errorBox);

  const element = h("article", { class: `question question-${question.kind}` }, ...children);
  return { element };
}
