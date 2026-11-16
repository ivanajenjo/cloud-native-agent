import { randomUUID } from "node:crypto";
import {
  NETWORK_ANSWER_OPTIONS,
  type NetworkAnswerOption,
  type Question,
  type QuestionOutcome,
} from "@cna/shared";
import type { GatewayClient } from "../gateway-client.js";

/** Final result of asking about host:port. */
export type AskResult = NetworkAnswerOption | "timeout" | "no_session";

export interface AskCoordinatorOptions {
  gateway: Pick<GatewayClient, "publishQuestion" | "resolveQuestion">;
  /** Default 120000. Also sent as question.timeoutMs. */
  timeoutMs?: number;
  /** Default () => `net-${randomUUID()}`. */
  newId?: () => string;
  /** Default () => new Date(). */
  now?: () => Date;
}

export type AnswerResult = "ok" | "not_found" | "already_resolved" | "invalid_value";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REMEMBERED_RESOLVED_IDS = 1000;

interface PendingQuestion {
  id: string;
  destination: string;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<AskResult>;
  resolve: (result: AskResult) => void;
}

function destinationKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function isAnswerOption(value: string): value is NetworkAnswerOption {
  return (NETWORK_ANSWER_OPTIONS as readonly string[]).includes(value);
}

/**
 * Decides, per host:port, whether the user allows a connection that the network policy
 * does not allow on its own (mode `ask`). Questions are published through the gateway and
 * answered through edge's API (ADR-0006, ADR-0008). Without an answer in time, or without
 * an active session, the result is a denial.
 */
export class AskCoordinator {
  private readonly gateway: Pick<GatewayClient, "publishQuestion" | "resolveQuestion">;
  private readonly timeoutMs: number;
  private readonly newId: () => string;
  private readonly now: () => Date;
  /** Pending questions by id. */
  private readonly pendingById = new Map<string, PendingQuestion>();
  /** Pending questions by destination, so concurrent asks share one question. */
  private readonly pendingByDestination = new Map<string, PendingQuestion>();
  /** Ids resolved by answer or timeout (or cancelled), oldest first. */
  private readonly resolvedIds = new Set<string>();

  constructor(options: AskCoordinatorOptions) {
    this.gateway = options.gateway;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.newId = options.newId ?? (() => `net-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Asks the user about host:port. Concurrent calls for the same host:port (while one is pending) share the SAME
   * question and promise. Builds the Question { id, kind:"network", method:"select",
   * title: `Allow network access to ${host}:${port}?`, options: [...NETWORK_ANSWER_OPTIONS], timeoutMs,
   * createdAt: now().toISOString(), network: { host, port } }.
   * If publishQuestion returns false → resolves "no_session" (no timer left running, nothing pending).
   * If nobody answers within timeoutMs → resolves "timeout" and calls resolveQuestion(id, "timeout").
   */
  async ask(host: string, port: number): Promise<AskResult> {
    const destination = destinationKey(host, port);
    const existing = this.pendingByDestination.get(destination);
    if (existing) {
      return existing.promise;
    }

    // Register before publishing, so an answer that arrives while the gateway is still
    // answering the publish request is accepted.
    const pending = this.register(this.newId(), destination);
    const question: Question = {
      id: pending.id,
      kind: "network",
      method: "select",
      title: `Allow network access to ${host}:${port}?`,
      options: [...NETWORK_ANSWER_OPTIONS],
      timeoutMs: this.timeoutMs,
      createdAt: this.now().toISOString(),
      network: { host, port },
    };

    let published: boolean;
    try {
      published = await this.gateway.publishQuestion(question);
    } catch {
      published = false;
    }
    if (!published) {
      // Not published: the gateway does not know this id, so it is not reported as resolved.
      this.close(pending, "no_session");
    }
    return pending.promise;
  }

  /**
   * Called by edge's ingress for POST /session/answers/net-*. value must be one of NETWORK_ANSWER_OPTIONS
   * (else "invalid_value", and the question stays pending). Resolves the waiting ask() with the value,
   * clears the timer, calls resolveQuestion(id, "answered"). Unknown id → "not_found"; an id that was already
   * resolved (answered, timed out) → "already_resolved" (remember the last 1000 resolved ids).
   */
  answer(id: string, value: string): AnswerResult {
    const pending = this.pendingById.get(id);
    if (!pending) {
      return this.resolvedIds.has(id) ? "already_resolved" : "not_found";
    }
    if (!isAnswerOption(value)) {
      return "invalid_value";
    }
    this.close(pending, value, "answered");
    return "ok";
  }

  /** Cancels all pending questions: each ask() resolves "no_session" and resolveQuestion(id, "cancelled") is called. For shutdown. */
  cancelAll(): void {
    for (const pending of [...this.pendingById.values()]) {
      this.close(pending, "no_session", "cancelled");
    }
  }

  /** Ids currently pending. */
  pendingIds(): string[] {
    return [...this.pendingById.keys()];
  }

  private register(id: string, destination: string): PendingQuestion {
    let resolve!: (result: AskResult) => void;
    const promise = new Promise<AskResult>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => this.close(pending, "timeout", "timeout"), this.timeoutMs);
    timer.unref();

    const pending: PendingQuestion = {
      id,
      destination,
      settled: false,
      timer,
      promise,
      resolve,
    };
    this.pendingById.set(id, pending);
    this.pendingByDestination.set(destination, pending);
    return pending;
  }

  /**
   * Ends a pending question once: clears its timer, removes it from the pending maps, resolves
   * the waiting asks and, if `outcome` is given, tells the gateway. Later calls are no-ops.
   */
  private close(pending: PendingQuestion, result: AskResult, outcome?: QuestionOutcome): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pendingById.delete(pending.id);
    if (this.pendingByDestination.get(pending.destination) === pending) {
      this.pendingByDestination.delete(pending.destination);
    }
    if (outcome !== undefined) {
      this.rememberResolved(pending.id);
      void this.gateway.resolveQuestion(pending.id, outcome);
    }
    pending.resolve(result);
  }

  private rememberResolved(id: string): void {
    this.resolvedIds.add(id);
    if (this.resolvedIds.size > MAX_REMEMBERED_RESOLVED_IDS) {
      const oldest = this.resolvedIds.values().next().value;
      if (oldest !== undefined) {
        this.resolvedIds.delete(oldest);
      }
    }
  }
}
