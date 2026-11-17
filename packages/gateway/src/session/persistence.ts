import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  type Checkpoint,
  SESSION_STATUSES,
  type SessionInfo,
  THINKING_LEVELS,
  TODO_STATUSES,
  type TodoItem,
} from "@cna/shared";
import { z } from "zod";

/** A checkpoint plus what restoring it needs (same fields as CheckpointRecord in manager.ts). */
export interface PersistedCheckpoint {
  checkpoint: Checkpoint;
  tree: string;
  forkIndex: number;
  todos: TodoItem[];
}

/** Content of /data/state/session.json. */
export interface PersistedSession {
  version: 1;
  /** SessionInfo without the fields that only make sense in memory. */
  info: Omit<SessionInfo, "pendingQuestions" | "suspended">;
  todos: TodoItem[];
  checkpoints: PersistedCheckpoint[];
  baselineTree: string | null;
}

export interface SessionStateStoreOptions {
  /** Absolute path, e.g. /data/state/session.json. */
  file: string;
  /** Default console.error. Receives only the file name and a short reason, never the content. */
  logError?: (message: string) => void;
}

const TodoItemSchema = z.object({
  id: z.number().int().min(1),
  text: z.string(),
  status: z.enum(TODO_STATUSES),
});

const PersistedSessionSchema = z.object({
  version: z.literal(1),
  info: z.object({
    id: z.string().min(1),
    status: z.enum(SESSION_STATUSES),
    repo: z.string(),
    baseBranch: z.string().nullable(),
    branch: z.string().nullable(),
    model: z.string().nullable(),
    thinking: z.enum(THINKING_LEVELS).nullable(),
    mode: z.enum(["plan", "auto"]),
    autoPush: z.boolean(),
    createdAt: z.string(),
    pr: z.number().int().min(1).nullable(),
    error: z.string().optional(),
  }),
  todos: z.array(TodoItemSchema),
  checkpoints: z.array(
    z.object({
      checkpoint: z.object({
        id: z.number().int().min(0),
        commit: z.string(),
        createdAt: z.string(),
        reason: z.enum(["start", "run"]),
      }),
      tree: z.string(),
      forkIndex: z.number().int().min(-1),
      todos: z.array(TodoItemSchema),
    }),
  ),
  baselineTree: z.string().nullable(),
}) satisfies z.ZodType<PersistedSession>;

/**
 * Atomic JSON store of the session state that Pi does not keep (ADR-0011). Writes are serialized
 * in call order; reads are not queued.
 */
export class SessionStateStore {
  private readonly file: string;
  private readonly tmpFile: string;
  private readonly corruptFile: string;
  private readonly logError: (message: string) => void;
  /** Every write and clear is chained here. Each link swallows its own error, so it never rejects. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: SessionStateStoreOptions) {
    this.file = options.file;
    this.tmpFile = `${options.file}.tmp`;
    this.corruptFile = `${options.file}.corrupt`;
    this.logError = options.logError ?? ((message: string) => console.error(message));
  }

  /** null if the file does not exist. A file that is not valid JSON or does not match the schema: logs, renames it to `<file>.corrupt` (replacing an older one) and returns null. Never throws for those cases. */
  async load(): Promise<PersistedSession | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      await this.quarantine("not valid JSON");
      return null;
    }

    const parsed = PersistedSessionSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue ? issue.path.map(String).join(".") : "";
      await this.quarantine(
        `does not match the schema (${issue?.code ?? "unknown"} at ${path || "root"})`,
      );
      return null;
    }
    return parsed.data;
  }

  /**
   * Writes atomically: creates the directory (recursive), writes `<file>.tmp` with mode 0o600, then `rename` over `<file>`.
   * Calls are serialized in call order (an internal promise chain); each call resolves when ITS write finished.
   * A failed write rejects that call only and does not break the following ones.
   */
  save(state: PersistedSession): Promise<void> {
    const write = this.queue.then(() => this.writeFileAtomically(state));
    this.queue = write.catch(() => undefined);
    return write;
  }

  /** Removes the file (no error if missing). Serialized with save(): a clear after a save leaves no file. */
  clear(): Promise<void> {
    const remove = this.queue.then(async () => {
      await rm(this.tmpFile, { force: true });
      await rm(this.file, { force: true });
    });
    this.queue = remove.catch(() => undefined);
    return remove;
  }

  private async writeFileAtomically(state: PersistedSession): Promise<void> {
    const json = `${JSON.stringify(state, null, 2)}\n`;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      // Removed first so a leftover temporary file never keeps a looser mode.
      await rm(this.tmpFile, { force: true });
      await writeFile(this.tmpFile, json, { mode: 0o600 });
      await rename(this.tmpFile, this.file);
    } catch (error) {
      await rm(this.tmpFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Moves an unreadable file aside, so the next start does not read it again. Never throws. */
  private async quarantine(reason: string): Promise<void> {
    const name = basename(this.file);
    this.logError(`session state: ${name} ${reason}; moved to ${name}.corrupt`);
    try {
      await rename(this.file, this.corruptFile);
    } catch (error) {
      this.logError(`session state: cannot move ${name} aside: ${errorCode(error)}`);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorCode(error: unknown): string {
  return isNodeError(error) && error.code ? error.code : "unknown error";
}
