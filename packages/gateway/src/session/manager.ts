import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTIVE_SESSION_STATUSES,
  type AnswerRequest,
  type Checkpoint,
  type CreateSessionRequest,
  type DiffResponse,
  type DiffSource,
  NETWORK_QUESTION_ID_PREFIX,
  type NetworkLogEntry,
  type PiMessage,
  type PostMessageRequest,
  type PostMessageResponse,
  type PromptDisposition,
  type Question,
  type QuestionOutcome,
  type RestoreCheckpointResponse,
  type SessionEvent,
  type SessionInfo,
  type SessionStats,
  type SessionStatus,
  type SetModelRequest,
  type TodoItem,
} from "@cna/shared";
import type {
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import type { EventLog } from "../events/event-log.js";
import type { ToolLog } from "../logs/tool-log.js";
import type { Notification, Notifier } from "../notifications/notifier.js";
import type { PiLaunchSpec } from "../pi/launch.js";
import { buildPiLaunch } from "../pi/launch.js";
import type { Redactor } from "../redact.js";
import {
  type RpcBridgeHandlers,
  RpcCommandError,
  type RpcCommandInput,
  type RpcEvent,
  type RpcExit,
} from "../rpc/bridge.js";
import {
  GitError,
  type GitRunner,
  prepareWorkspace,
  slugify,
  workspaceState,
} from "../workspace/git.js";
import {
  deleteCheckpointRefsAfter,
  diffWorkingTree,
  mergeBaseWith,
  restoreWorkingTree,
  saveCheckpointRef,
  snapshotWorkingTree,
} from "../workspace/snapshot.js";
import { normalizeRpcEvent, uiRequestToNotify, uiRequestToQuestion } from "./normalize.js";
import { PendingQuestions } from "./pending-questions.js";
import type { PersistedSession, SessionStateStore } from "./persistence.js";
import { answerToUiResponse, outcomeOfAnswer } from "./questions.js";
import { SessionError, type SessionService } from "./service.js";
import { parseSessionStats } from "./stats.js";

/** What the manager needs from a running Pi (RpcBridge implements it). */
export interface PiProcess {
  send(command: RpcCommandInput, options?: { timeoutMs?: number }): Promise<unknown>;
  respondUi(response: RpcExtensionUIResponse): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

export interface SessionManagerOptions {
  events: EventLog;
  redactor: Redactor;
  git: GitRunner;
  /** Production: (spec, handlers) => RpcBridge.start(spec, handlers). Tests: a fake. */
  startPi: (spec: PiLaunchSpec, handlers: RpcBridgeHandlers) => PiProcess;
  /** Everything buildPiLaunch needs except cwd, model, thinking, baseBranch, autoPush, plan. */
  pi: {
    piCli: string;
    agentDir: string;
    sessionDir: string;
    extensions: string[];
    systemPromptFile?: string;
    /** web.yaml, read by the web extension (--cna-web-config). */
    webConfigFile?: string;
    env: Record<string, string | undefined>;
  };
  /** Tool execution log (/data/logs/tools.jsonl). Failures never affect the session. */
  toolLog?: ToolLog;
  /** Absolute path of the workspace dir (e.g. /data/workspace/repo). Deleted on close and before each new clone. */
  workspaceDir: string;
  /** providers.yaml `default`, used when the request has no model. */
  defaultModel?: string;
  gitIdentity?: { name?: string; email?: string };
  /** Default "https://github.com/" (tests pass a file:// base). */
  remoteBase?: string;
  /** Push notifications of status changes (ADR-0009). Absent: no notifications. */
  notifier?: Notifier;
  /**
   * Milliseconds without activity after which an idle `ready` session stops Pi (ADR-0011 §5).
   * Absent or 0: Pi is never suspended.
   */
  idleTimeoutMs?: number;
  /**
   * Stores the session state Pi does not keep (ADR-0011 §2) and recovers it in restore(). Absent:
   * nothing is saved nor recovered.
   */
  stateStore?: SessionStateStore;
  /** Default console. Receives only redacted text. */
  logger?: { info(message: string): void; error(message: string): void };
  now?: () => Date;
  /** Default randomUUID. */
  newId?: () => string;
}

/** Timeout of `abort`: Pi answers only once the session is idle again. */
const ABORT_TIMEOUT_MS = 60_000;
/** Max length of a stderr line of Pi that reaches the logger. */
const MAX_LOGGED_LINE_LENGTH = 500;
const PROMPT_DISPOSITIONS: readonly PromptDisposition[] = ["started", "queued", "handled"];
const MESSAGE_STATUSES: readonly SessionStatus[] = ["running", "waiting_input", "ready"];
/** Max length of the message of a push notification (after redaction). */
const MAX_NOTIFICATION_MESSAGE_LENGTH = 300;
/** Warning sent after a restart that lost a run or pending questions (ADR-0011 §3). */
const LOST_RUN_MESSAGE =
  "La ejecución en curso o las preguntas pendientes se perdieron al reiniciar el gateway; vuelve a pedírselo al agente.";

/** A checkpoint plus what restoring its conversation needs (ADR-0007, point 3). */
interface CheckpointRecord {
  checkpoint: Checkpoint;
  /** Tree sha of the snapshot: a run that changed nothing gets no checkpoint. */
  tree: string;
  /** Index, in get_fork_messages, of the user message that follows the checkpoint. -1 = unknown. */
  forkIndex: number;
  /** Task list at the checkpoint. */
  todos: TodoItem[];
}

/**
 * The single session of this replica (ADR-0003): clones the repo, runs Pi in RPC mode on it,
 * turns Pi's events into SSE events and keeps the state machine of the session.
 */
export class SessionManager implements SessionService {
  private readonly options: SessionManagerOptions;
  private readonly events: EventLog;
  private readonly redactor: Redactor;
  private readonly logger: { info(message: string): void; error(message: string): void };
  private readonly now: () => Date;
  private readonly newId: () => string;

  private info: SessionInfo | null = null;
  private pi: PiProcess | null = null;
  /** Complete task list, as last reported by the `todo` tool. Reset by create(). */
  private todoList: TodoItem[] = [];
  private readonly questions = new PendingQuestions({
    onResolved: (questionId, outcome) => {
      this.emit({ type: "question_resolved", questionId, outcome });
      // A timeout changes the pending set outside any other operation, so the status is recomputed.
      if (outcome === "timeout") {
        this.refreshStatus();
      }
    },
  });
  /** True when no run is in progress (Pi reported agent_settled, or never started). */
  private settled = true;
  /** True while close() is running; events and background work then count as stale. */
  private closing = false;
  /**
   * Background jobs (clone + start Pi) run one at a time: they all use the same workspace dir,
   * so a new clone must not start while the previous one (of a closed session) still writes.
   */
  private workspaceQueue: Promise<void> = Promise.resolve();
  /** Checkpoints of the current session, oldest first. Reset by create() and close(). */
  private checkpointList: CheckpointRecord[] = [];
  /**
   * Tree of the working tree as last checkpointed or restored: a run that leaves it unchanged gets no
   * checkpoint. Not the last checkpoint's tree: after a restore the files may match an older one.
   * Reset by create() and close(), together with checkpointList.
   */
  private baselineTree: string | null = null;
  /** Run checkpoints are chained here, and so are the requests that need them. Never rejects. */
  private checkpointQueue: Promise<void> = Promise.resolve();
  /** True while a checkpoint is being restored: no new prompt or restore may start meanwhile. */
  private restoring = false;
  /** Number of run checkpoints queued or being taken. The idle suspension waits for them. */
  private checkpointJobs = 0;
  /** Stop of a Pi that the idle suspension is stopping. A new Pi starts only after it. */
  private suspension: Promise<void> | undefined;
  /** Timer of the idle suspension, if armed (ADR-0011 §5). */
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleTimeoutMs: number;
  /** Set by shutdown(): no Pi may start any more. */
  private shuttingDown = false;

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.events = options.events;
    this.redactor = options.redactor;
    this.logger = options.logger ?? {
      info: (message) => console.log(message),
      error: (message) => console.error(message),
    };
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
  }

  /** Stops Pi if running (used on gateway shutdown). Does not delete the workspace. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearIdleTimer();
    const pi = this.pi;
    this.pi = null;
    if (pi !== null) {
      await this.stopPiQuietly(pi);
    }
  }

  /**
   * Recovers the session saved before a gateway restart (ADR-0011 §3). Called once, before the gateway
   * serves requests. Never throws: a failure is logged, and a session that cannot go on ends in `error`.
   */
  async restore(): Promise<void> {
    const store = this.options.stateStore;
    if (store === undefined) {
      return;
    }
    try {
      const state = await store.load();
      if (state === null) {
        // Without saved state there is no session to resume (ADR-0011 §3).
        await this.removeWorkspaceQuietly();
        return;
      }
      const discardReason = await this.discardReasonOf(state);
      if (discardReason !== null) {
        await this.removeWorkspaceQuietly();
        await this.clearStateQuietly();
        this.logger.info(`session state discarded: ${discardReason}`);
        return;
      }

      this.adoptState(state);
      const info = this.info;
      if (info === null) {
        return;
      }
      if (info.status === "cloning") {
        this.setStatus("error", "the gateway restarted while the repository was being cloned");
      } else if (info.status === "error") {
        // Already failed: the status goes out again so that the replay shows why.
        this.emit(
          info.error === undefined
            ? { type: "status", status: "error" }
            : { type: "status", status: "error", error: info.error },
        );
      } else {
        const lostRun = state.info.status === "running" || state.info.status === "waiting_input";
        await this.resumePi(info.id, lostRun);
      }
      this.persist();
    } catch (error) {
      this.logger.error(`session restore: ${this.redactor.redactString(errorMessage(error))}`);
    }
  }

  /** Why a saved state must not be resumed, or null if it can be. Checks the workspace repository too. */
  private async discardReasonOf(state: PersistedSession): Promise<string | null> {
    if (state.info.status === "closed") {
      return "the session was closed";
    }
    if (!(await pathExists(join(this.options.workspaceDir, ".git")))) {
      return "the workspace has no repository";
    }
    return null;
  }

  /** Makes the saved state the in-memory session. Pi is not started here. */
  private adoptState(state: PersistedSession): void {
    this.info = { ...state.info, suspended: false, pendingQuestions: [] };
    this.todoList = state.todos.map((item) => ({ ...item }));
    this.checkpointList = state.checkpoints.map((record) => ({
      checkpoint: { ...record.checkpoint },
      tree: record.tree,
      forkIndex: record.forkIndex,
      todos: record.todos.map((item) => ({ ...item })),
    }));
    this.baselineTree = state.baselineTree;
    this.settled = true;
  }

  /**
   * Starts Pi on the restored session with the same id, so Pi reopens the conversation, and sends the
   * conversation as `history`. A run or pending questions of the previous process are lost: `lostRun`
   * adds a warning. Failures end in `error`; this never throws.
   */
  private async resumePi(sessionId: string, lostRun: boolean): Promise<void> {
    let pi: PiProcess;
    try {
      pi = this.launchPi(sessionId);
    } catch (error) {
      this.setStatus("error", this.redactor.redactString(errorMessage(error)));
      return;
    }
    this.pi = pi;
    const info = this.current(sessionId);
    if (info === null) {
      return;
    }
    // Not setStatus: a `ready` session stays `ready`, and no push notification says "finished" for a
    // run that was lost.
    info.status = "ready";
    this.emit({ type: "status", status: "ready" });
    this.armIdleTimer();

    let messages: PiMessage[] = [];
    try {
      const data = await pi.send({ type: "get_messages" });
      const list: unknown = isRecord(data) ? data.messages : undefined;
      messages = Array.isArray(list) ? (list as PiMessage[]) : [];
    } catch (error) {
      this.logger.error(
        `session restore: get_messages: ${this.redactor.redactString(errorMessage(error))}`,
      );
    }
    this.emit({ type: "history", messages });
    if (lostRun) {
      this.emit({ type: "notify", level: "warning", message: LOST_RUN_MESSAGE });
    }
  }

  /**
   * Writes the state Pi does not keep (ADR-0011 §2). Called after every change of it. Never throws and
   * never waits: a failed write is logged. Nothing is written once the session is closed.
   */
  private persist(): void {
    const store = this.options.stateStore;
    const info = this.info;
    if (store === undefined || info === null || info.status === "closed") {
      return;
    }
    // Only the fields that survive a restart: questions and suspension live in memory.
    const { pendingQuestions: _pendingQuestions, suspended: _suspended, ...saved } = info;
    const state: PersistedSession = {
      version: 1,
      info: { ...saved },
      todos: this.todoList.map((item) => ({ ...item })),
      checkpoints: this.checkpointList.map((record) => ({
        checkpoint: { ...record.checkpoint },
        tree: record.tree,
        forkIndex: record.forkIndex,
        todos: record.todos.map((item) => ({ ...item })),
      })),
      baselineTree: this.baselineTree,
    };
    void store.save(state).catch((error: unknown) => {
      this.logger.error(`session state: ${this.redactor.redactString(errorMessage(error))}`);
    });
  }

  /** Removes the saved state. A failure is logged and does not reject. */
  private async clearStateQuietly(): Promise<void> {
    try {
      await this.options.stateStore?.clear();
    } catch (error) {
      this.logger.error(`session state: ${this.redactor.redactString(errorMessage(error))}`);
    }
  }

  get(): SessionInfo | null {
    return this.info === null ? null : this.snapshot(this.info);
  }

  async create(request: CreateSessionRequest): Promise<SessionInfo> {
    // Temporary until PR sessions land (ADR-0011): a body without pr always has a prompt.
    if (request.pr !== undefined || request.prompt === undefined) {
      throw new SessionError("invalid_request", "pr is not supported yet");
    }
    const previous = this.info;
    if (
      previous !== null &&
      (this.closing || (previous.status !== "error" && previous.status !== "closed"))
    ) {
      throw new SessionError("session_exists");
    }

    this.clearIdleTimer();
    // A previous session in error is discarded. Its Pi, if still alive, stops before the new clone.
    let stopping: Promise<void> | undefined;
    if (previous !== null) {
      const previousPi = this.pi;
      this.pi = null;
      stopping = previousPi !== null ? this.stopPiQuietly(previousPi) : undefined;
      this.questions.discardAll();
    }
    // A new session starts with an empty replay buffer, also after a close (ids keep growing).
    this.events.clear();
    this.todoList = [];
    this.checkpointList = [];
    this.baselineTree = null;
    this.checkpointQueue = Promise.resolve();

    const info: SessionInfo = {
      id: this.newId(),
      status: "cloning",
      repo: request.repo,
      baseBranch: request.baseBranch ?? null,
      branch: null,
      model: request.model ?? this.options.defaultModel ?? null,
      thinking: request.thinking ?? null,
      mode: request.mode ?? "auto",
      autoPush: request.autoPush ?? false,
      createdAt: this.now().toISOString(),
      pr: request.pr ?? null,
      suspended: false,
      pendingQuestions: [],
    };
    this.info = info;
    this.settled = true;
    this.persist();
    this.emit({ type: "status", status: "cloning" });

    const sessionId = info.id;
    const job = this.workspaceQueue.then(async () => {
      await stopping;
      await this.start(sessionId, request);
    });
    this.workspaceQueue = job.catch(() => undefined);
    // start() catches its own failures; this is only a last safety net.
    void job.catch((error: unknown) => {
      this.logger.error(`session ${sessionId}: ${this.redactor.redactString(errorMessage(error))}`);
    });

    return this.snapshot(info);
  }

  todos(): TodoItem[] {
    if (this.info === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    return this.todoList.map((item) => ({ ...item }));
  }

  async postMessage(request: PostMessageRequest): Promise<PostMessageResponse> {
    const info = this.info;
    if (info === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    if (!MESSAGE_STATUSES.includes(info.status)) {
      throw new SessionError("invalid_state");
    }
    // A checkpoint being taken must not count the message sent next (its forkIndex).
    await this.checkpointQueue;
    if (this.restoring) {
      throw new SessionError("invalid_state", "a checkpoint is being restored");
    }

    const pi = await this.ensurePi();
    const command: RpcCommandInput = this.settled
      ? { type: "prompt", message: request.text }
      : {
          type: "prompt",
          message: request.text,
          streamingBehavior: request.mode ?? "followUp",
        };
    const data = await this.sendToPi(pi, command);
    const disposition = dispositionOf(data);
    if (disposition === undefined) {
      throw new Error("unexpected response to prompt: no disposition");
    }
    if (disposition === "started") {
      this.settled = false;
      this.refreshStatus();
    }
    return { disposition };
  }

  async answer(questionId: string, answer: AnswerRequest): Promise<void> {
    if (this.info === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    const entry = this.questions.get(questionId);
    if (entry?.source === "pi") {
      const check = answerToUiResponse(entry.question, answer);
      if (!check.ok) {
        throw new SessionError("invalid_request", this.redactor.redactString(check.message));
      }
      const pi = this.pi;
      if (pi === null) {
        throw new SessionError("invalid_state", "Pi is not running");
      }
      pi.respondUi(check.response);
      this.questions.resolve(questionId, outcomeOfAnswer(answer));
      this.refreshStatus();
      return;
    }
    // Network questions are answered in edge (ADR-0008) and never get here.
    if (
      this.questions.wasResolved(questionId) &&
      !questionId.startsWith(NETWORK_QUESTION_ID_PREFIX)
    ) {
      throw new SessionError("question_resolved");
    }
    throw new SessionError("question_not_found");
  }

  async setModel(request: SetModelRequest): Promise<void> {
    const info = this.info;
    if (info === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    // Provider and model id are split at the first "/": model ids may contain "/" and ":".
    const slash = request.model.indexOf("/");
    if (slash <= 0) {
      throw new SessionError("invalid_request", "model must be provider/model");
    }
    const provider = request.model.slice(0, slash);
    const modelId = request.model.slice(slash + 1);
    // Validated first: a malformed model must not start a suspended Pi.
    const pi = await this.ensurePi();

    try {
      await pi.send({ type: "set_model", provider, modelId });
      if (request.thinking !== undefined) {
        await pi.send({ type: "set_thinking_level", level: request.thinking });
      }
    } catch (error) {
      if (error instanceof RpcCommandError) {
        const message = this.redactor.redactString(error.message);
        throw error.reason === "failed"
          ? new SessionError("unknown_model", message)
          : new SessionError("invalid_state", message);
      }
      throw error;
    }

    info.model = request.model;
    if (request.thinking !== undefined) {
      info.thinking = request.thinking;
    }
    this.persist();
  }

  async abort(): Promise<void> {
    if (this.info === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    for (const question of this.questions.list()) {
      if (this.questions.get(question.id)?.source !== "pi") {
        continue;
      }
      this.pi?.respondUi({ type: "extension_ui_response", id: question.id, cancelled: true });
      this.questions.resolve(question.id, "cancelled");
    }

    const pi = this.pi;
    if (pi !== null) {
      try {
        await pi.send({ type: "abort" }, { timeoutMs: ABORT_TIMEOUT_MS });
        // Pi answers once it is idle again, so the run is over even if agent_settled was lost.
        this.settled = true;
      } catch (error) {
        this.logger.error(`abort: ${this.redactor.redactString(errorMessage(error))}`);
      }
    }
    this.refreshStatus();
  }

  async messages(): Promise<PiMessage[]> {
    if (this.info === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    const pi = await this.ensurePi();
    const data = await this.sendToPi(pi, { type: "get_messages" });
    const list: unknown = isRecord(data) ? data.messages : undefined;
    const messages = Array.isArray(list) ? (list as PiMessage[]) : [];
    return this.redactor.redact(messages);
  }

  /** Token usage and cost of the session (Pi get_session_stats, ADR-0011 §8). Starts Pi if suspended. */
  async stats(): Promise<SessionStats> {
    const info = this.info;
    if (info === null) {
      throw new SessionError("no_session");
    }
    if (info.status === "cloning") {
      throw new SessionError("invalid_state", "the workspace is still being cloned");
    }
    this.markActivity();
    const pi = await this.ensurePi();
    const stats = parseSessionStats(await this.sendToPi(pi, { type: "get_session_stats" }));
    if (stats === null) {
      throw new SessionError("invalid_state", "Pi did not return session stats");
    }
    return stats;
  }

  checkpoints(): Checkpoint[] {
    if (this.info === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    return this.checkpointList.map((record) => ({ ...record.checkpoint }));
  }

  /**
   * Restores the working tree to a checkpoint and, with `conversation`, also the conversation (Pi
   * `fork`). With `conversation`, a fork that fails or is cancelled puts the files back as they were.
   * Throws no_session, invalid_state (not ready, unknown conversation position, fork cancelled, git or
   * Pi failure, files not put back) and checkpoint_not_found.
   */
  async restoreCheckpoint(
    id: number,
    options: { conversation: boolean },
  ): Promise<RestoreCheckpointResponse> {
    const started = this.info;
    if (started === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    await this.checkpointQueue;
    if (!this.isCurrent(started.id)) {
      throw new SessionError("no_session");
    }
    if (started.status !== "ready") {
      throw new SessionError(
        "invalid_state",
        "checkpoints can only be restored when the session is ready",
      );
    }
    const record = this.checkpointList.find((item) => item.checkpoint.id === id);
    if (record === undefined) {
      throw new SessionError("checkpoint_not_found");
    }
    if (this.restoring) {
      throw new SessionError("invalid_state", "a checkpoint is being restored");
    }
    // Checked before anything is touched: a restore that cannot fork must not move the files.
    if (options.conversation && record.forkIndex < 0) {
      throw new SessionError(
        "invalid_state",
        "the conversation position of this checkpoint is unknown",
      );
    }

    const git = this.options.git;
    const dir = this.options.workspaceDir;
    this.restoring = true;
    try {
      if (options.conversation) {
        // Starts Pi if it is suspended: the fork needs it. Files are not touched before that.
        const pi = await this.ensurePi();
        await this.restoreFilesAndConversation(pi, record);
      } else {
        await restoreWorkingTree(git, dir, record.checkpoint.commit);
      }
      this.baselineTree = record.tree;
      if (options.conversation) {
        await deleteCheckpointRefsAfter(git, dir, id);
        this.checkpointList = this.checkpointList.filter((item) => item.checkpoint.id <= id);
        this.todoList = record.todos.map((item) => ({ ...item }));
        this.emit({ type: "todo", todos: this.todoList });
      }
      this.persist();
    } catch (error) {
      if (error instanceof GitError || error instanceof RpcCommandError) {
        throw new SessionError("invalid_state", this.redactor.redactString(errorMessage(error)));
      }
      throw error;
    } finally {
      this.restoring = false;
    }

    this.emit({ type: "checkpoint", action: "restored", checkpoint: { ...record.checkpoint } });
    return {
      checkpoint: { ...record.checkpoint },
      conversationRestored: options.conversation,
    };
  }

  /**
   * Lists the working tree against the base branch (`from.kind` "base") or against a checkpoint.
   * Throws no_session, invalid_state (session still cloning, or no base/branch yet, or git failure)
   * and checkpoint_not_found.
   */
  async diff(checkpointId?: number): Promise<DiffResponse> {
    const info = this.info;
    if (info === null) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    const baseBranch = info.baseBranch;
    if (info.status === "cloning" || baseBranch === null || info.branch === null) {
      throw new SessionError("invalid_state", "the workspace is not ready for a diff");
    }

    const git = this.options.git;
    const dir = this.options.workspaceDir;
    try {
      let from: DiffSource;
      if (checkpointId === undefined) {
        from = {
          kind: "base",
          branch: baseBranch,
          commit: await mergeBaseWith(git, dir, baseBranch),
        };
      } else {
        const record = this.checkpointList.find((item) => item.checkpoint.id === checkpointId);
        if (record === undefined) {
          throw new SessionError("checkpoint_not_found");
        }
        from = { kind: "checkpoint", id: checkpointId, commit: record.checkpoint.commit };
      }
      const result = await diffWorkingTree(git, dir, from.commit);
      return {
        from,
        files: this.redactor.redact(result.files),
        patch: this.redactor.redactString(result.patch),
        truncated: result.truncated,
      };
    } catch (error) {
      if (error instanceof GitError) {
        throw new SessionError("invalid_state", this.redactor.redactString(errorMessage(error)));
      }
      throw error;
    }
  }

  async close(options: { force: boolean }): Promise<void> {
    const info = this.info;
    if (info === null || this.closing) {
      throw new SessionError("no_session");
    }
    this.markActivity();
    this.closing = true;
    try {
      if (!options.force && info.status !== "cloning") {
        await this.checkWorkspaceState(info);
      }
      this.clearIdleTimer();
      const pi = this.pi;
      this.pi = null;
      if (pi !== null) {
        await this.stopPiQuietly(pi);
      }
      this.questions.resolveAll("cancelled");
      await rm(this.options.workspaceDir, { recursive: true, force: true });
      await this.clearStateQuietly();
      this.setStatus("closed");
      this.info = null;
      this.checkpointList = [];
      this.baselineTree = null;
      this.checkpointQueue = Promise.resolve();
    } finally {
      this.closing = false;
    }
  }

  publishNetworkQuestion(question: Question): boolean {
    const info = this.info;
    if (info === null || this.closing || !ACTIVE_SESSION_STATUSES.includes(info.status)) {
      return false;
    }
    if (this.questions.get(question.id) !== undefined) {
      return true;
    }
    this.questions.add(question, "edge");
    this.emit({ type: "question", question });
    this.refreshStatus();
    return true;
  }

  resolveNetworkQuestion(questionId: string, outcome: QuestionOutcome): boolean {
    if (this.questions.get(questionId)?.source !== "edge") {
      return false;
    }
    this.questions.resolve(questionId, outcome);
    this.refreshStatus();
    return true;
  }

  publishNetworkEntry(entry: NetworkLogEntry): void {
    if (this.info === null) {
      return;
    }
    this.emit({ type: "network", entry });
  }

  /** Clone, branch, start Pi and send the first prompt. Never throws: failures become status `error`. */
  private async start(sessionId: string, request: CreateSessionRequest): Promise<void> {
    if (!this.isCurrent(sessionId)) {
      return;
    }
    try {
      await rm(this.options.workspaceDir, { recursive: true, force: true });
      const prepared = await prepareWorkspace({
        git: this.options.git,
        repo: request.repo,
        baseBranch: request.baseBranch,
        dir: this.options.workspaceDir,
        slug: slugify(request.prompt ?? ""),
        userName: this.options.gitIdentity?.name,
        userEmail: this.options.gitIdentity?.email,
        remoteBase: this.options.remoteBase,
      });

      const info = this.current(sessionId);
      if (info === null) {
        // Closed while cloning: Pi must not start.
        await this.removeWorkspaceQuietly();
        return;
      }
      info.baseBranch = prepared.baseBranch;
      info.branch = prepared.branch;
      this.persist();

      await this.createStartCheckpoint(sessionId);
      if (this.current(sessionId) === null) {
        // Closed while taking the first checkpoint: Pi must not start.
        await this.removeWorkspaceQuietly();
        return;
      }

      const pi = this.launchPi(sessionId);
      this.pi = pi;
      this.settled = false;
      this.setStatus("running");

      const data = await pi.send({ type: "prompt", message: request.prompt ?? "" });
      if (this.isCurrent(sessionId) && dispositionOf(data) === "handled") {
        // Handled by an extension: there is no run to wait for.
        this.settled = true;
        this.refreshStatus();
      }
    } catch (error) {
      await this.failStart(sessionId, error);
    }
  }

  /** Checkpoint 0 right after cloning, before Pi starts. A failure is logged and the session goes on. */
  private async createStartCheckpoint(sessionId: string): Promise<void> {
    const git = this.options.git;
    const dir = this.options.workspaceDir;
    try {
      const { commit, tree } = await snapshotWorkingTree(git, dir, "cna checkpoint 0");
      await saveCheckpointRef(git, dir, 0, commit);
      if (!this.isCurrent(sessionId)) {
        return;
      }
      const checkpoint: Checkpoint = {
        id: 0,
        commit,
        createdAt: this.now().toISOString(),
        reason: "start",
      };
      // The conversation is empty: the first user message is fork index 0.
      this.checkpointList.push({ checkpoint, tree, forkIndex: 0, todos: [] });
      this.baselineTree = tree;
      this.persist();
      this.emit({ type: "checkpoint", action: "created", checkpoint: { ...checkpoint } });
    } catch (error) {
      this.logger.error(`checkpoint 0: ${this.redactor.redactString(errorMessage(error))}`);
    }
  }

  /** Queues the checkpoint of the run that just settled, after the jobs already queued. Never rejects. */
  private enqueueRunCheckpoint(sessionId: string): void {
    this.checkpointJobs++;
    const job = this.checkpointQueue
      .then(() => this.createRunCheckpoint(sessionId))
      .finally(() => {
        this.checkpointJobs--;
      });
    this.checkpointQueue = job.catch(() => undefined);
  }

  /**
   * Starts Pi on the workspace with the session id (ADR-0011 §1): a Pi started again with the same id
   * reopens the conversation. Throws invalid_state if the session has no base branch yet.
   */
  private launchPi(sessionId: string): PiProcess {
    const info = this.current(sessionId);
    if (info === null || info.baseBranch === null) {
      throw new SessionError("invalid_state", "the workspace is not ready");
    }
    const spec = buildPiLaunch({
      ...this.options.pi,
      sessionId: info.id,
      cwd: this.options.workspaceDir,
      model: info.model ?? undefined,
      thinking: info.thinking ?? undefined,
      baseBranch: info.baseBranch,
      autoPush: info.autoPush,
      plan: info.mode === "plan",
      webConfigFile: this.options.pi.webConfigFile,
    });
    return this.options.startPi(spec, this.handlersFor(sessionId));
  }

  /**
   * The running Pi, starting it again if the idle suspension stopped it (ADR-0011 §5). Throws
   * invalid_state if the session cannot have a Pi (cloning, closed, in error, or without branch).
   */
  private async ensurePi(): Promise<PiProcess> {
    if (this.pi !== null) {
      return this.pi;
    }
    // The stopped Pi must have exited before a new one starts, or its exit would clear the new one.
    if (this.suspension !== undefined) {
      await this.suspension;
      if (this.pi !== null) {
        return this.pi;
      }
    }
    const info = this.info;
    if (
      info === null ||
      this.shuttingDown ||
      this.closing ||
      info.status === "cloning" ||
      info.status === "closed" ||
      info.status === "error" ||
      info.baseBranch === null ||
      info.branch === null
    ) {
      throw new SessionError("invalid_state", "the session has no Pi to talk to");
    }
    // Synchronous from here to the assignment: concurrent callers all see this Pi.
    const pi = this.launchPi(info.id);
    this.pi = pi;
    // A fresh Pi is idle: the run it lost, if any, is not resumed (ADR-0011 §3).
    this.settled = true;
    info.suspended = false;
    this.armIdleTimer();
    return pi;
  }

  /** Any public call (except get) and any Pi event counts as activity: the idle timer restarts. */
  private markActivity(): void {
    this.armIdleTimer();
  }

  /** (Re)arms the idle timer if the suspension is on and Pi is running. */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || this.info === null || this.pi === null) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.suspendIfIdle();
    }, this.idleTimeoutMs);
    timer.unref();
    this.idleTimer = timer;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Stops Pi if the session is still idle; otherwise re-arms the timer when the wait may end later. */
  private async suspendIfIdle(): Promise<void> {
    const info = this.info;
    const pi = this.pi;
    if (
      info === null ||
      pi === null ||
      info.status !== "ready" ||
      !this.settled ||
      this.questions.size > 0 ||
      this.restoring ||
      this.closing
    ) {
      return;
    }
    if (this.checkpointJobs > 0) {
      this.armIdleTimer();
      return;
    }
    this.pi = null;
    info.suspended = true;
    const minutes = Math.round((this.idleTimeoutMs / 60_000) * 1000) / 1000;
    this.logger.info(`pi suspended after ${minutes} min of inactivity`);
    const stopping = this.stopPiQuietly(pi);
    this.suspension = stopping;
    try {
      await stopping;
    } finally {
      if (this.suspension === stopping) {
        this.suspension = undefined;
      }
    }
  }

  /** Creates a checkpoint if the working tree changed since the last one. Errors are logged. */
  private async createRunCheckpoint(sessionId: string): Promise<void> {
    const pi = this.pi;
    if (!this.isCurrent(sessionId) || pi === null) {
      return;
    }
    const git = this.options.git;
    const dir = this.options.workspaceDir;
    try {
      const { commit, tree } = await snapshotWorkingTree(git, dir, "cna checkpoint");
      if (this.baselineTree === tree) {
        return;
      }
      const last = this.checkpointList.at(-1);
      const id = last === undefined ? 0 : last.checkpoint.id + 1;
      await saveCheckpointRef(git, dir, id, commit);
      const forkIndex = await this.countForkEntries(pi);
      if (!this.isCurrent(sessionId)) {
        return;
      }
      const checkpoint: Checkpoint = {
        id,
        commit,
        createdAt: this.now().toISOString(),
        reason: "run",
      };
      this.checkpointList.push({
        checkpoint,
        tree,
        forkIndex,
        todos: this.todoList.map((item) => ({ ...item })),
      });
      this.baselineTree = tree;
      this.persist();
      this.emit({ type: "checkpoint", action: "created", checkpoint: { ...checkpoint } });
    } catch (error) {
      this.logger.error(`checkpoint:${this.redactor.redactString(errorMessage(error))}`);
    }
  }

  /** Number of user messages Pi can fork from now; -1 if Pi does not answer with a list. */
  private async countForkEntries(pi: PiProcess): Promise<number> {
    try {
      const entries = forkEntriesOf(await pi.send({ type: "get_fork_messages" }));
      return entries?.length ?? -1;
    } catch {
      return -1;
    }
  }

  /**
   * Restores the files to the checkpoint and the conversation with Pi's `fork`, as one step: if the fork
   * fails, the files go back to the state they had before (safety snapshot, not a checkpoint). Throws
   * the original error, or invalid_state if the files could not be put back either.
   */
  private async restoreFilesAndConversation(
    pi: PiProcess,
    record: CheckpointRecord,
  ): Promise<void> {
    const git = this.options.git;
    const dir = this.options.workspaceDir;
    const safety = await snapshotWorkingTree(git, dir, "cna restore safety");
    try {
      // A failure half way through the file restore is rolled back like a failed fork.
      await restoreWorkingTree(git, dir, record.checkpoint.commit);
      await this.forkToCheckpoint(pi, record);
    } catch (error) {
      try {
        await restoreWorkingTree(git, dir, safety.commit);
      } catch (putBackError) {
        const message = `${errorMessage(error)}; the files could not be put back: ${errorMessage(putBackError)}`;
        this.logger.error(`restore: ${this.redactor.redactString(message)}`);
        throw new SessionError("invalid_state", this.redactor.redactString(message));
      }
      throw error;
    }
  }

  /** Moves the conversation back to the checkpoint with Pi's `fork`. Throws invalid_state. */
  private async forkToCheckpoint(pi: PiProcess, record: CheckpointRecord): Promise<void> {
    const entries = forkEntriesOf(await this.sendToPi(pi, { type: "get_fork_messages" }));
    if (entries === null) {
      throw new SessionError("invalid_state", "Pi did not list the conversation messages");
    }
    if (record.forkIndex >= entries.length) {
      // The conversation is already at this point: nothing to fork.
      return;
    }
    const entry: unknown = entries[record.forkIndex];
    const entryId = isRecord(entry) ? entry.entryId : undefined;
    if (typeof entryId !== "string") {
      throw new SessionError("invalid_state", "Pi sent a fork message without an entryId");
    }
    const data = await this.sendToPi(pi, { type: "fork", entryId });
    if (isRecord(data) && data.cancelled === true) {
      throw new SessionError("invalid_state", "fork cancelled");
    }
  }

  private async failStart(sessionId: string, error: unknown): Promise<void> {
    const message = this.redactor.redactString(errorMessage(error));
    if (!this.isCurrent(sessionId)) {
      this.logger.error(`session ${sessionId} was closed while starting: ${message}`);
      await this.removeWorkspaceQuietly();
      return;
    }
    const pi = this.pi;
    this.pi = null;
    if (pi !== null) {
      await this.stopPiQuietly(pi);
    }
    this.questions.resolveAll("cancelled", "pi");
    this.setStatus("error", message);
    this.logger.error(`session ${sessionId}: ${message}`);
  }

  /** Handlers given to startPi for one session. Events of a session that is no longer current are dropped. */
  private handlersFor(sessionId: string): RpcBridgeHandlers {
    return {
      onEvent: (event) => {
        if (this.isCurrent(sessionId)) {
          this.handlePiEvent(event);
        }
      },
      onUiRequest: (request) => {
        if (this.isCurrent(sessionId)) {
          this.handleUiRequest(request);
        }
      },
      onExit: (exit) => {
        if (this.isCurrent(sessionId)) {
          this.handlePiExit(exit);
        }
      },
      onStderr: (line) => {
        this.logger.info(
          `pi: ${this.redactor.redactString(line).slice(0, MAX_LOGGED_LINE_LENGTH)}`,
        );
      },
      onProtocolError: (message) => {
        this.logger.error(
          `pi protocol: ${this.redactor.redactString(message).slice(0, MAX_LOGGED_LINE_LENGTH)}`,
        );
      },
    };
  }

  private handlePiEvent(event: RpcEvent): void {
    this.markActivity();
    this.recordTool(event);
    // The end of a run is agent_settled: agent_end can be followed by a retry or queued messages.
    if (event.type === "agent_start") {
      this.settled = false;
      this.refreshStatus();
    } else if (event.type === "agent_settled") {
      this.settled = true;
      this.refreshStatus();
      const sessionId = this.info?.id;
      if (sessionId !== undefined) {
        this.enqueueRunCheckpoint(sessionId);
      }
    }
    for (const sessionEvent of normalizeRpcEvent(event)) {
      if (sessionEvent.type === "todo") {
        this.todoList = sessionEvent.todos;
        this.persist();
      } else if (sessionEvent.type === "mode") {
        const info = this.info;
        // The plan-mode extension may report the mode it already has: no event then.
        if (info === null || info.mode === sessionEvent.mode) {
          continue;
        }
        info.mode = sessionEvent.mode;
        this.persist();
      }
      this.emit(sessionEvent);
    }
  }

  /** Feeds the tool execution log. Errors are logged and never reach the event flow. */
  private recordTool(event: RpcEvent): void {
    const toolLog = this.options.toolLog;
    const sessionId = this.info?.id;
    if (toolLog === undefined || sessionId === undefined) {
      return;
    }
    const { toolCallId, toolName } = event;
    if (typeof toolCallId !== "string" || typeof toolName !== "string") {
      return;
    }
    try {
      if (event.type === "tool_execution_start") {
        toolLog.start(sessionId, { toolCallId, toolName, args: event.args ?? null });
      } else if (event.type === "tool_execution_end") {
        toolLog.end(sessionId, {
          toolCallId,
          toolName,
          result: event.result ?? null,
          isError: event.isError === true,
          ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        });
      }
    } catch (error) {
      this.logger.error(`tool log: ${this.redactor.redactString(errorMessage(error))}`);
    }
  }

  private handleUiRequest(request: RpcExtensionUIRequest): void {
    this.markActivity();
    const question = uiRequestToQuestion(request, this.now());
    if (question === null) {
      const notify = uiRequestToNotify(request);
      if (notify !== null) {
        this.emit(notify);
      }
      return;
    }
    if (this.questions.get(question.id) !== undefined) {
      this.logger.error(
        `pi: question ${this.redactor.redactString(question.id)} is already pending`,
      );
      return;
    }
    this.questions.add(question, "pi");
    this.emit({ type: "question", question });
    this.refreshStatus();
  }

  private handlePiExit(exit: RpcExit): void {
    this.pi = null;
    if (exit.expected) {
      return;
    }
    this.questions.resolveAll("cancelled", "pi");
    this.setStatus("error", `pi exited unexpectedly (code ${exit.code}, signal ${exit.signal})`);
  }

  /** Recomputes waiting_input / running / ready after a change in the pending questions or in `settled`. */
  private refreshStatus(): void {
    const info = this.info;
    if (info === null || this.closing || info.status === "error" || info.status === "closed") {
      return;
    }
    if (this.questions.size > 0) {
      this.setStatus("waiting_input");
    } else if (info.status === "cloning") {
      this.setStatus("cloning");
    } else {
      this.setStatus(this.settled ? "ready" : "running");
    }
  }

  private setStatus(status: SessionStatus, error?: string): void {
    const info = this.info;
    if (info === null) {
      return;
    }
    const safeError = error === undefined ? undefined : this.redactor.redactString(error);
    if (info.status === status && info.error === safeError) {
      return;
    }
    const previous = info.status;
    info.status = status;
    info.error = safeError;
    this.persist();
    this.emit(
      safeError === undefined
        ? { type: "status", status }
        : { type: "status", status, error: safeError },
    );
    this.notifyStatusChange(previous, status, safeError);
    if (status === "ready") {
      this.armIdleTimer();
    } else if (status === "error" || status === "closed") {
      this.clearIdleTimer();
    }
  }

  /** Sends the push notification of a status change, if it has one. Never throws, never waits. */
  private notifyStatusChange(previous: SessionStatus, status: SessionStatus, error?: string): void {
    const notifier = this.options.notifier;
    const draft = notifier === undefined ? null : this.notificationFor(previous, status, error);
    if (notifier === undefined || draft === null) {
      return;
    }
    const notification: Notification = {
      event: draft.event,
      title: this.redactor.redactString(draft.title),
      message: this.redactor.redactString(draft.message).slice(0, MAX_NOTIFICATION_MESSAGE_LENGTH),
    };
    try {
      void Promise.resolve(notifier.notify(notification)).catch((notifyError: unknown) => {
        this.logNotificationError(notifyError);
      });
    } catch (notifyError) {
      this.logNotificationError(notifyError);
    }
  }

  /** The notification for entering `status` from `previous` (ADR-0009, funcionalidad 5); null if none. */
  private notificationFor(
    previous: SessionStatus,
    status: SessionStatus,
    error: string | undefined,
  ): Notification | null {
    const info = this.info;
    if (info === null) {
      return null;
    }
    if (status === "waiting_input" && previous !== "waiting_input") {
      return {
        event: "waiting_input",
        title: `cna: ${info.repo} needs your input`,
        message: this.questions.list()[0]?.title ?? "A question is waiting.",
      };
    }
    if (status === "ready" && (previous === "running" || previous === "waiting_input")) {
      return {
        event: "ready",
        title: `cna: ${info.repo} finished`,
        message: `Branch ${info.branch ?? "(none)"} is ready.`,
      };
    }
    if (status === "error") {
      return {
        event: "error",
        title: `cna: ${info.repo} failed`,
        message: error ?? "Unknown error",
      };
    }
    return null;
  }

  private logNotificationError(error: unknown): void {
    this.logger.error(`notifications: ${this.redactor.redactString(errorMessage(error))}`);
  }

  /** Throws invalid_state if the workspace has uncommitted changes or commits not pushed. */
  private async checkWorkspaceState(info: SessionInfo): Promise<void> {
    let state: Awaited<ReturnType<typeof workspaceState>>;
    try {
      state = await workspaceState(this.options.git, this.options.workspaceDir, {
        checkUnpushed: info.branch !== null,
      });
    } catch (error) {
      throw new SessionError(
        "invalid_state",
        this.redactor.redactString(`could not check the workspace: ${errorMessage(error)}`),
      );
    }
    if (state === "uncommitted") {
      throw new SessionError("invalid_state", "uncommitted changes");
    }
    if (state === "unpushed") {
      throw new SessionError("invalid_state", "commits not pushed");
    }
  }

  /** Sends a command to Pi; a rejected command becomes invalid_state. */
  private async sendToPi(pi: PiProcess, command: RpcCommandInput): Promise<unknown> {
    try {
      return await pi.send(command);
    } catch (error) {
      if (error instanceof RpcCommandError) {
        throw new SessionError("invalid_state", this.redactor.redactString(error.message));
      }
      throw error;
    }
  }

  private async stopPiQuietly(pi: PiProcess): Promise<void> {
    try {
      await pi.stop();
    } catch (error) {
      this.logger.error(`pi stop: ${this.redactor.redactString(errorMessage(error))}`);
    }
  }

  private async removeWorkspaceQuietly(): Promise<void> {
    try {
      await rm(this.options.workspaceDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.error(`workspace removal: ${this.redactor.redactString(errorMessage(error))}`);
    }
  }

  /** The session if it is still the current one (same id, not closing). */
  private current(sessionId: string): SessionInfo | null {
    return this.isCurrent(sessionId) ? this.info : null;
  }

  private isCurrent(sessionId: string): boolean {
    return !this.closing && this.info?.id === sessionId;
  }

  /** Every event goes through the redactor before it reaches the log (AGENTS.md invariant). */
  private emit(event: SessionEvent): void {
    this.events.append(this.redactor.redact(event));
  }

  private snapshot(info: SessionInfo): SessionInfo {
    return { ...info, pendingQuestions: this.questions.list() };
  }
}

function dispositionOf(data: unknown): PromptDisposition | undefined {
  const value = isRecord(data) ? data.disposition : undefined;
  return PROMPT_DISPOSITIONS.find((disposition) => disposition === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `messages` list of a get_fork_messages response, or null if Pi did not send one. */
function forkEntriesOf(data: unknown): unknown[] | null {
  const list: unknown = isRecord(data) ? data.messages : undefined;
  return Array.isArray(list) ? list : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
