import type { AnswerRequest, Question, QuestionMethod, QuestionOutcome } from "@cna/shared";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

export type QuestionSource = "pi" | "edge";

/** How many resolved ids are remembered (to answer 409 instead of 404). */
const MAX_RESOLVED_IDS = 1000;

/** Pending questions in insertion order, plus the ids of recently resolved ones. */
export class QuestionRegistry {
  private readonly pending = new Map<string, { question: Question; source: QuestionSource }>();
  private readonly resolved = new Set<string>();

  /** Throws if the id is already pending. */
  add(question: Question, source: QuestionSource): void {
    if (this.pending.has(question.id)) {
      throw new Error(`question ${question.id} is already pending`);
    }
    this.pending.set(question.id, { question, source });
    this.resolved.delete(question.id);
  }

  get(id: string): { question: Question; source: QuestionSource } | undefined {
    const entry = this.pending.get(id);
    return entry ? { question: entry.question, source: entry.source } : undefined;
  }

  /** Pending questions, in insertion order. */
  list(): Question[] {
    return [...this.pending.values()].map((entry) => entry.question);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Removes and returns it; undefined if it was not pending. Remembers the id as resolved. */
  resolve(id: string): Question | undefined {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return undefined;
    }
    this.pending.delete(id);
    this.remember(id);
    return entry.question;
  }

  /** True if the id was resolved earlier (for 409). Keeps at most the last 1000 resolved ids. */
  wasResolved(id: string): boolean {
    return this.resolved.has(id);
  }

  /** Removes all pending questions (of one source, or all) and returns them; they count as resolved. */
  clear(source?: QuestionSource): Question[] {
    const cleared: Question[] = [];
    for (const [id, entry] of this.pending) {
      if (source !== undefined && entry.source !== source) {
        continue;
      }
      cleared.push(entry.question);
      this.pending.delete(id);
      this.remember(id);
    }
    return cleared;
  }

  private remember(id: string): void {
    // Re-insert so that the Set keeps the most recent resolution last.
    this.resolved.delete(id);
    this.resolved.add(id);
    if (this.resolved.size > MAX_RESOLVED_IDS) {
      for (const oldest of this.resolved) {
        this.resolved.delete(oldest);
        break;
      }
    }
  }
}

export type AnswerCheck =
  | { ok: true; response: RpcExtensionUIResponse }
  | { ok: false; message: string };

const EXPECTED_ANSWER: Record<QuestionMethod, string> = {
  select: "{value} with one of the options",
  confirm: "{confirmed}",
  input: "{value}",
  editor: "{value}",
};

/**
 * Validates an API answer against the question's method and builds Pi's extension_ui_response:
 * - any method + {cancelled:true} → {type:"extension_ui_response", id, cancelled:true}
 * - select + {value} → value must be one of question.options
 * - confirm + {confirmed}
 * - input/editor + {value}
 * Any other combination → { ok:false, message } (e.g. "confirm expects {confirmed}").
 */
export function answerToUiResponse(question: Question, answer: AnswerRequest): AnswerCheck {
  const id = question.id;

  if ("cancelled" in answer) {
    return { ok: true, response: { type: "extension_ui_response", id, cancelled: true } };
  }

  const mismatch = (): AnswerCheck => ({
    ok: false,
    message: `${question.method} expects ${EXPECTED_ANSWER[question.method] ?? "a known answer"}`,
  });

  switch (question.method) {
    case "select": {
      if (!("value" in answer) || typeof answer.value !== "string") {
        return mismatch();
      }
      if (!(question.options ?? []).includes(answer.value)) {
        return { ok: false, message: "value is not one of the options of the question" };
      }
      return { ok: true, response: { type: "extension_ui_response", id, value: answer.value } };
    }

    case "confirm": {
      if (!("confirmed" in answer) || typeof answer.confirmed !== "boolean") {
        return mismatch();
      }
      return {
        ok: true,
        response: { type: "extension_ui_response", id, confirmed: answer.confirmed },
      };
    }

    case "input":
    case "editor": {
      if (!("value" in answer) || typeof answer.value !== "string") {
        return mismatch();
      }
      return { ok: true, response: { type: "extension_ui_response", id, value: answer.value } };
    }

    default:
      return mismatch();
  }
}

export function outcomeOfAnswer(answer: AnswerRequest): QuestionOutcome {
  return "cancelled" in answer ? "cancelled" : "answered";
}
