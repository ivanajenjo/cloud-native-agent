import type { Question, QuestionOutcome } from "@cna/shared";
import { QuestionRegistry, type QuestionSource } from "./questions.js";

export interface PendingQuestionsOptions {
  /** Called once for every question that stops being pending, in order. */
  onResolved(questionId: string, outcome: QuestionOutcome): void;
}

/**
 * Pending questions of the session, with the timeouts of the Pi ones. Owns the
 * QuestionRegistry and the timers; the manager reacts to the resolutions through onResolved.
 */
export class PendingQuestions {
  private readonly options: PendingQuestionsOptions;
  private readonly registry = new QuestionRegistry();
  /** Timers of the Pi questions that have a timeout. */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(options: PendingQuestionsOptions) {
    this.options = options;
  }

  /** Adds it and arms its timer if question.timeoutMs is set and source is "pi". Throws if the id is pending. */
  add(question: Question, source: QuestionSource): void {
    this.registry.add(question, source);
    if (source === "pi" && question.timeoutMs !== undefined) {
      this.armTimer(question.id, question.timeoutMs);
    }
  }

  get(id: string): { question: Question; source: QuestionSource } | undefined {
    return this.registry.get(id);
  }

  /** Pending questions in insertion order. */
  list(): Question[] {
    return this.registry.list();
  }

  get size(): number {
    return this.registry.size;
  }

  wasResolved(id: string): boolean {
    return this.registry.wasResolved(id);
  }

  /** Clears the timer, removes it, calls onResolved. false if it was not pending. */
  resolve(id: string, outcome: QuestionOutcome): boolean {
    this.clearTimer(id);
    if (this.registry.resolve(id) === undefined) {
      return false;
    }
    this.options.onResolved(id, outcome);
    return true;
  }

  /** Resolves every pending question of that source (or all) with the outcome, in insertion order. Returns how many. */
  resolveAll(outcome: QuestionOutcome, source?: QuestionSource): number {
    let count = 0;
    for (const question of this.registry.list()) {
      if (source !== undefined && this.registry.get(question.id)?.source !== source) {
        continue;
      }
      if (this.resolve(question.id, outcome)) {
        count++;
      }
    }
    return count;
  }

  /** Clears every timer and drops every pending question WITHOUT calling onResolved (they still count as resolved). */
  discardAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.registry.clear();
  }

  private armTimer(id: string, timeoutMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(id);
      // Pi resolves its own dialogs on timeout, so nothing is sent to Pi here.
      this.resolve(id, "timeout");
    }, timeoutMs);
    // A pending question must not keep the process alive by itself.
    timer.unref();
    this.timers.set(id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}
