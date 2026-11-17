import type { AnswerRequest, Question } from "@cna/shared";
import { optionLabel } from "@cna/shared/client";
import { sanitize, style } from "./style.js";

const CANCEL_COMMAND = "/cancel";
const CONFIRM_YES = new Set(["s", "si", "sí", "y", "yes"]);
const CONFIRM_NO = new Set(["n", "no"]);

function kindLabel(question: Question): string {
  switch (question.kind) {
    case "ask_user":
      return "Pregunta";
    case "confirm":
      return "Confirmación";
    case "plan":
      return "Plan";
    case "network":
      return question.network ? `Red: ${question.network.host}:${question.network.port}` : "Red";
  }
}

/** Lines of the question body that depend on its method. Each one ends with "\n". */
function methodPrompt(question: Question): string {
  switch (question.method) {
    case "select": {
      const options = (question.options ?? []).map(
        (option, index) => `  ${index + 1}) ${sanitize(optionLabel(question, option))}\n`,
      );
      return `${options.join("")}Elige un número (o /cancel):\n`;
    }
    case "confirm":
      return "¿Confirmas? [s/n] (o /cancel):\n";
    case "input": {
      const placeholder = question.placeholder ? ` [${sanitize(question.placeholder)}]` : "";
      return `Respuesta (o /cancel):${placeholder}\n`;
    }
    case "editor": {
      let prefill = "";
      if (question.prefill) {
        const text = sanitize(question.prefill);
        prefill = `Texto inicial:\n${text.endsWith("\n") ? text : `${text}\n`}`;
      }
      return `${prefill}Escribe la respuesta; termina con una línea que solo tenga "." (o /cancel):\n`;
    }
  }
}

/** Multi-line prompt shown when a question arrives (ends with "\n"). */
export function formatQuestion(question: Question, color: boolean): string {
  const header = `? ${kindLabel(question)}:`;
  let out = `${style(sanitize(header), color, "bold", "yellow")}\n`;
  out += `${sanitize(question.title)}\n`;
  if (question.message) {
    out += `${sanitize(question.message)}\n`;
  }
  if (question.timeoutMs !== undefined) {
    out += `(caduca en ${Math.ceil(question.timeoutMs / 1000)} s)\n`;
  }
  return out + methodPrompt(question);
}

export type AnswerParse = { ok: true; answer: AnswerRequest } | { ok: false; error: string };

function ok(answer: AnswerRequest): AnswerParse {
  return { ok: true, answer };
}

function fail(error: string): AnswerParse {
  return { ok: false, error };
}

function parseSelect(question: Question, input: string): AnswerParse {
  const options = question.options ?? [];
  if (options.length === 0) {
    return fail("La pregunta no tiene opciones");
  }
  const text = input.trim();
  if (/^\d+$/.test(text)) {
    const choice = Number(text);
    if (choice >= 1 && choice <= options.length) {
      return ok({ value: options[choice - 1] as string });
    }
  } else if (options.includes(text)) {
    return ok({ value: text });
  }
  return fail(`Opción no válida: elige un número del 1 al ${options.length}`);
}

function parseConfirm(input: string): AnswerParse {
  const text = input.trim().normalize("NFC").toLowerCase();
  if (CONFIRM_YES.has(text)) {
    return ok({ confirmed: true });
  }
  if (CONFIRM_NO.has(text)) {
    return ok({ confirmed: false });
  }
  return fail("Responde s o n");
}

/** Interprets what the user typed. For `editor` questions `input` is the already joined multi-line text. */
export function parseAnswer(question: Question, input: string): AnswerParse {
  if (input.trim() === CANCEL_COMMAND) {
    return ok({ cancelled: true });
  }
  switch (question.method) {
    case "select":
      return parseSelect(question, input);
    case "confirm":
      return parseConfirm(input);
    case "input":
      return ok({ value: input.replace(/\r?\n$/, "") });
    case "editor":
      return ok({ value: input });
  }
}

/** True for `editor` questions: the chat collects lines until a line with only "." */
export function isMultiline(question: Question): boolean {
  return question.method === "editor";
}
