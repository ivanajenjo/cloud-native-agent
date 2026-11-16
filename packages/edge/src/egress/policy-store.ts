import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NETWORK_MODES, type NetworkMode } from "@cna/shared";
import { type AllowlistEntry, formatAllowlistEntry, parseAllowlistEntry } from "./allowlist.js";

export interface StoredPolicy {
  mode: NetworkMode;
  /** Canonical allowlist entries added by the user ("allow always" or config). */
  allow: string[];
}

export const DEFAULT_POLICY: StoredPolicy = { mode: "ask", allow: [] };

function isNetworkMode(value: unknown): value is NetworkMode {
  return (NETWORK_MODES as readonly unknown[]).includes(value);
}

/** Canonicalizes and deduplicates entries; throws on the first invalid one. */
function canonicalizeEntries(entries: readonly string[]): string[] {
  const canonical = entries.map((text) => formatAllowlistEntry(parseAllowlistEntry(text)));
  return [...new Set(canonical)];
}

export class PolicyStore {
  /** Serializes writes: each task starts after the previous one has settled. */
  private queue: Promise<void> = Promise.resolve();
  private policy: StoredPolicy;

  private constructor(
    private readonly path: string,
    policy: StoredPolicy,
  ) {
    this.policy = policy;
  }

  /**
   * Loads `path` (JSON). Missing file → DEFAULT_POLICY (the file is not created until the first change).
   * Invalid JSON, unknown mode, non-array allow, or an entry that parseAllowlistEntry rejects → throws Error
   * (edge must not start with a policy it cannot read: fail closed).
   * Entries are stored canonicalized (formatAllowlistEntry(parseAllowlistEntry(x))) and deduplicated.
   */
  static async load(path: string): Promise<PolicyStore> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return new PolicyStore(path, { ...DEFAULT_POLICY, allow: [] });
      }
      throw error;
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`policy file ${path} is not valid JSON`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`policy file ${path} must contain a JSON object`);
    }
    const { mode, allow } = data as { mode?: unknown; allow?: unknown };
    if (!isNetworkMode(mode)) {
      throw new Error(`policy file ${path} has an unknown mode`);
    }
    if (!Array.isArray(allow) || !allow.every((item) => typeof item === "string")) {
      throw new Error(`policy file ${path} must have an array of strings in "allow"`);
    }
    return new PolicyStore(path, { mode, allow: canonicalizeEntries(allow) });
  }

  /** Copy of the current policy. */
  get(): StoredPolicy {
    return { mode: this.policy.mode, allow: [...this.policy.allow] };
  }

  /** Parsed entries of `allow`. */
  entries(): readonly AllowlistEntry[] {
    return this.policy.allow.map((text) => parseAllowlistEntry(text));
  }

  /** Adds an entry (canonicalized, no duplicates) and persists. Throws on an invalid entry. */
  async addAllow(entry: string): Promise<void> {
    const canonical = formatAllowlistEntry(parseAllowlistEntry(entry));
    return this.enqueue(async () => {
      if (this.policy.allow.includes(canonical)) return;
      await this.persist({ mode: this.policy.mode, allow: [...this.policy.allow, canonical] });
    });
  }

  /** Changes the mode and persists. */
  async setMode(mode: NetworkMode): Promise<void> {
    if (!isNetworkMode(mode)) {
      throw new Error(`unknown network mode: ${String(mode)}`);
    }
    return this.enqueue(async () => {
      await this.persist({ mode, allow: [...this.policy.allow] });
    });
  }

  /** Runs `task` after every previously queued write. A failed task does not block the queue. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Writes `next` atomically (temp file + rename) and updates memory only if the write succeeded. */
  private async persist(next: StoredPolicy): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      // writeFile keeps the mode of a leftover temp file; set it explicitly.
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.policy = next;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
