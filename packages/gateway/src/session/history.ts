import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HISTORY_LIMIT, type HistoryEntry, SESSION_STATUSES, SessionModeSchema } from "@cna/shared";
import { z } from "zod";

/** What is stored per session; `resumable` is computed when listing. */
export type HistoryRecord = Omit<HistoryEntry, "resumable">;

export interface HistoryStoreOptions {
  /** Absolute path, e.g. /data/state/history.json. */
  file: string;
  /** Pi's --session-dir (absolute). */
  sessionDir: string;
  /** Default HISTORY_LIMIT from @cna/shared. */
  limit?: number;
  /** Default console.error. Never receives file contents. */
  logError?: (message: string) => void;
}

/** Session ids are also used to find and delete files, so only this shape is accepted (ADR-0011). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const FILE_VERSION = 1;

const StatsSchema = z.object({
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
  cost: z.number(),
  messages: z.object({
    user: z.number(),
    assistant: z.number(),
    toolCalls: z.number(),
  }),
  context: z
    .object({
      tokens: z.number().nullable(),
      window: z.number(),
      percent: z.number().nullable(),
    })
    .nullable(),
});

/** The id is checked apart: records with an invalid id are dropped, not treated as a corrupt file. */
const RecordSchema = z.object({
  id: z.string(),
  repo: z.string(),
  baseBranch: z.string().nullable(),
  branch: z.string().nullable(),
  pr: z.number().int().min(1).nullable(),
  mode: SessionModeSchema,
  model: z.string().nullable(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  stats: StatsSchema.nullable(),
});

const FileSchema = z.object({
  version: z.literal(FILE_VERSION),
  sessions: z.array(RecordSchema),
});

/**
 * Persistent history of the sessions of this replica (feature 10, ADR-0011). Keeps at most `limit`
 * records and deletes the Pi session file of each record it drops.
 */
export class HistoryStore {
  private readonly file: string;
  private readonly sessionDir: string;
  private readonly limit: number;
  private readonly logError: (message: string) => void;

  private loading: Promise<void> | undefined;
  /** Records by id, as persisted. */
  private records = new Map<string, HistoryRecord>();
  // Every upsert is chained here, so writes happen in call order. Each link swallows its own
  // error, so the chain never rejects; the caller of a failed upsert still gets the rejection.
  private queue: Promise<void> = Promise.resolve();

  constructor(options: HistoryStoreOptions) {
    this.file = options.file;
    this.sessionDir = options.sessionDir;
    this.limit = Math.max(1, Math.floor(options.limit ?? HISTORY_LIMIT));
    this.logError = options.logError ?? ((message: string) => console.error(message));
  }

  /** Reads the file. Missing → empty. Invalid JSON or shape → empty, logged, file renamed to `<file>.corrupt`. Never throws. Call once at startup. */
  load(): Promise<void> {
    this.loading ??= this.loadFile().catch((error: unknown) => {
      this.logError(`history: cannot load: ${errorMessage(error)}`);
    });
    return this.loading;
  }

  /** Copy of the record, or undefined. */
  get(id: string): HistoryRecord | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  /** Newest first (createdAt desc; ties by id). `resumable` = closedAt !== null && branch !== null && hasPiSession(id). */
  async list(): Promise<HistoryEntry[]> {
    const sorted = sortNewestFirst([...this.records.values()]);
    return Promise.all(
      sorted.map(async (record) => ({
        ...structuredClone(record),
        resumable:
          record.closedAt !== null &&
          record.branch !== null &&
          (await this.hasPiSession(record.id)),
      })),
    );
  }

  /**
   * Inserts or replaces the record with the same id, keeps at most `limit` records (drops the oldest by
   * createdAt, never the one just upserted) and, for each dropped record, deletes its Pi session file(s).
   * Persists atomically. Serialized in call order. A failed write rejects that call only.
   */
  upsert(record: HistoryRecord): Promise<void> {
    if (!isValidSessionId(record.id)) {
      return Promise.reject(new Error("invalid session id"));
    }
    const parsed = RecordSchema.safeParse(record);
    if (!parsed.success) {
      return Promise.reject(new Error("invalid history record"));
    }
    const next: HistoryRecord = parsed.data;
    const run = this.queue.then(() => this.apply(next));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** True if `sessionDir` holds a file named `<anything>_<id>.jsonl` (no recursion). */
  async hasPiSession(id: string): Promise<boolean> {
    try {
      return (await this.piSessionPaths(id)).length > 0;
    } catch (error) {
      this.logError(`history: cannot read the Pi session dir: ${errorMessage(error)}`);
      return false;
    }
  }

  private async loadFile(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) {
        this.logError(`history: cannot read ${this.file}: ${errorMessage(error)}`);
      }
      return;
    }

    const records = parseFile(text);
    if (records === undefined) {
      this.logError(`history: invalid file, starting empty; keeping it as ${this.file}.corrupt`);
      await rename(this.file, `${this.file}.corrupt`).catch((error: unknown) => {
        this.logError(`history: cannot move the invalid file: ${errorMessage(error)}`);
      });
      return;
    }
    this.records = new Map(records.map((record) => [record.id, record]));
  }

  /** Runs inside the queue: the in-memory state changes only after the file is written. */
  private async apply(record: HistoryRecord): Promise<void> {
    await this.load();

    const others = sortNewestFirst([...this.records.values()].filter((r) => r.id !== record.id));
    const kept = others.slice(0, this.limit - 1);
    const dropped = others.slice(this.limit - 1);
    const sessions = sortNewestFirst([record, ...kept]);

    await this.writeFile(sessions);
    this.records = new Map(sessions.map((r) => [r.id, r]));

    for (const old of dropped) {
      await this.removePiSession(old.id);
    }
  }

  private async writeFile(sessions: HistoryRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    const body = `${JSON.stringify({ version: FILE_VERSION, sessions }, null, 2)}\n`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  private async removePiSession(id: string): Promise<void> {
    try {
      for (const path of await this.piSessionPaths(id)) {
        await rm(path);
      }
    } catch (error) {
      this.logError(`history: cannot delete the Pi session of ${id}: ${errorMessage(error)}`);
    }
  }

  /** Regular files of `sessionDir` named `<anything>_<id>.jsonl`. Symlinks are never returned. */
  private async piSessionPaths(id: string): Promise<string[]> {
    if (!isValidSessionId(id)) {
      return [];
    }
    let names: string[];
    try {
      names = await readdir(this.sessionDir);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const suffix = `_${id}.jsonl`;
    const paths: string[] = [];
    for (const name of names) {
      if (!name.endsWith(suffix)) {
        continue;
      }
      const path = join(this.sessionDir, name);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile()) {
        paths.push(path);
      }
    }
    return paths;
  }
}

function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/** Parses the file. Undefined when it is not valid JSON or does not match the format. */
function parseFile(text: string): HistoryRecord[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.sessions.filter((record) => isValidSessionId(record.id));
}

/** Newest first by createdAt, ties by id. Sorts and returns the same array. */
function sortNewestFirst(records: HistoryRecord[]): HistoryRecord[] {
  return records.sort((a, b) => timeOf(b) - timeOf(a) || compareStrings(a.id, b.id));
}

function timeOf(record: HistoryRecord): number {
  const time = Date.parse(record.createdAt);
  return Number.isNaN(time) ? 0 : time;
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
