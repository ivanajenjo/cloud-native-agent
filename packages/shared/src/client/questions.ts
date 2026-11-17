/** Texts for the user, in Spanish. The option values themselves are the API contract. */
import type { Question } from "../questions.js";

const NETWORK_LABELS: ReadonlyMap<string, string> = new Map([
  ["allow_once", "Permitir esta vez"],
  ["allow_always", "Permitir siempre"],
  ["deny", "Denegar"],
]);

const PLAN_LABELS: ReadonlyMap<string, string> = new Map([
  ["approve", "Aprobar"],
  ["request_changes", "Pedir cambios"],
]);

/** Label to show for a select option. */
export function optionLabel(question: Question, option: string): string {
  const labels =
    question.kind === "network"
      ? NETWORK_LABELS
      : question.kind === "plan"
        ? PLAN_LABELS
        : undefined;
  return labels?.get(option) ?? option;
}
