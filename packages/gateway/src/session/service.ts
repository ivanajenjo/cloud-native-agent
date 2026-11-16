import type {
  AnswerRequest,
  ApiErrorCode,
  CreateSessionRequest,
  NetworkLogEntry,
  PiMessage,
  PostMessageRequest,
  PostMessageResponse,
  Question,
  QuestionOutcome,
  SessionInfo,
  SetModelRequest,
  TodoItem,
} from "@cna/shared";

/**
 * Error raised by the session service. The HTTP layer maps `code` to a status:
 * no_session → 404, question_not_found → 404, session_exists → 409, invalid_state → 409,
 * question_resolved → 409, invalid_request → 400, mode_not_supported → 400, unknown_model → 400.
 * `message` must be safe to show to the client (no secrets).
 */
export class SessionError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message?: string) {
    super(message ?? code);
    this.name = "SessionError";
    this.code = code;
  }
}

/**
 * The single session of this replica (ADR-0003). Implemented by SessionManager; the HTTP routes
 * depend only on this interface.
 */
export interface SessionService {
  /** Current session, or null if there is none (never created, or closed with DELETE). */
  get(): SessionInfo | null;

  /**
   * Starts a session and returns at once with status "cloning"; cloning, starting Pi and sending
   * the first prompt continue in the background (progress goes out as `status` events).
   * Throws session_exists if a session exists whose status is not "error" nor "closed".
   * `mode` defaults to "auto"; "plan" starts read-only until a plan is approved. The task list
   * is reset to empty.
   */
  create(request: CreateSessionRequest): Promise<SessionInfo>;

  /**
   * Sends a user message. Throws no_session; invalid_state unless the status is running,
   * waiting_input or ready. While running/waiting_input it is sent with streamingBehavior
   * `request.mode ?? "followUp"`.
   */
  postMessage(request: PostMessageRequest): Promise<PostMessageResponse>;

  /**
   * Answers a pending question raised by Pi. Throws no_session; question_not_found if the id was
   * never pending; question_resolved if it was already resolved; invalid_request if the answer does
   * not fit the question (e.g. {confirmed} for a select). Network questions (`net-*`) are answered
   * in edge and never reach this method; if one does, throw question_not_found.
   */
  answer(questionId: string, answer: AnswerRequest): Promise<void>;

  /** Changes model (and thinking level). Throws no_session; invalid_state if Pi is not running; unknown_model if Pi rejects it. */
  setModel(request: SetModelRequest): Promise<void>;

  /** Aborts the current run and cancels the pending Pi questions. Throws no_session. */
  abort(): Promise<void>;

  /** Current task list (last report of the `todo` tool), a copy. Throws no_session. */
  todos(): TodoItem[];

  /** Full conversation from Pi (`get_messages`), redacted. Throws no_session; invalid_state if Pi is not running. */
  messages(): Promise<PiMessage[]>;

  /**
   * Stops Pi, deletes the workspace and marks the session closed (get() returns null afterwards).
   * Without force, throws invalid_state if the workspace has uncommitted changes or commits not
   * pushed to the remote branch. Throws no_session.
   */
  close(options: { force: boolean }): Promise<void>;

  /** Internal (edge, ADR-0008): publishes a network question. false if there is no active session. */
  publishNetworkQuestion(question: Question): boolean;

  /** Internal (edge): a network question stopped being pending. false if it was not pending. */
  resolveNetworkQuestion(questionId: string, outcome: QuestionOutcome): boolean;

  /** Internal (edge): emits a `network` event if there is a session; otherwise drops it. */
  publishNetworkEntry(entry: NetworkLogEntry): void;
}
