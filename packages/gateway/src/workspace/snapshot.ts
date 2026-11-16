import { randomUUID } from "node:crypto";
import { lstat, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DIFF_PATCH_MAX_BYTES, type DiffFile, type DiffFileStatus } from "@cna/shared";
import { GitError, type GitRunner } from "./git.js";

/*
 * Working-tree snapshots (ADR-0007, point 3). A snapshot is a commit whose tree is the working
 * tree: tracked and untracked files, ignored files excluded. It is built with a temporary index
 * (GIT_INDEX_FILE) so the real index, HEAD and the branch are never touched.
 */

export const CHECKPOINT_REF_PREFIX = "refs/cna/checkpoints/";

/** Identity of snapshot commits, so they work without user.name/user.email configured. */
export const SNAPSHOT_IDENTITY = { name: "cna", email: "cna@localhost" } as const;

const SNAPSHOT_IDENTITY_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: SNAPSHOT_IDENTITY.name,
  GIT_AUTHOR_EMAIL: SNAPSHOT_IDENTITY.email,
  GIT_COMMITTER_NAME: SNAPSHOT_IDENTITY.name,
  GIT_COMMITTER_EMAIL: SNAPSHOT_IDENTITY.email,
};

const CHECKPOINT_REF_PATTERN = /^refs\/cna\/checkpoints\/(0|[1-9][0-9]*)$/;

/** Tree of the working tree: tracked + untracked, ignored excluded. Never touches HEAD, the index, or the branch. */
export async function snapshotTree(git: GitRunner, dir: string): Promise<string> {
  const indexFile = temporaryIndexPath(dir);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    if ((await resolveHead(git, dir)) === null) {
      await git(["read-tree", "--empty"], { cwd: dir, env });
    } else {
      await git(["read-tree", "HEAD"], { cwd: dir, env });
    }
    await git(["add", "-A"], { cwd: dir, env });
    const { stdout } = await git(["write-tree"], { cwd: dir, env });
    return stdout.trim();
  } finally {
    await rm(indexFile, { force: true });
  }
}

/** snapshotTree + commit-tree (parent HEAD if it exists) with SNAPSHOT_IDENTITY. */
export async function snapshotWorkingTree(
  git: GitRunner,
  dir: string,
  message: string,
): Promise<{ commit: string; tree: string }> {
  const tree = await snapshotTree(git, dir);
  const parent = await resolveHead(git, dir);
  const args = ["commit-tree", tree];
  if (parent !== null) {
    args.push("-p", parent);
  }
  // Snapshots must not depend on the user's signing configuration.
  args.push("--no-gpg-sign", "-m", message);
  const { stdout } = await git(args, { cwd: dir, env: SNAPSHOT_IDENTITY_ENV });
  return { commit: stdout.trim(), tree };
}

/** git update-ref refs/cna/checkpoints/<id> <commit>. */
export async function saveCheckpointRef(
  git: GitRunner,
  dir: string,
  id: number,
  commit: string,
): Promise<void> {
  assertCheckpointId(id);
  assertRevision(commit, "commit");
  await git(["update-ref", `${CHECKPOINT_REF_PREFIX}${id}`, commit], { cwd: dir });
}

/** Deletes refs/cna/checkpoints/<n> for every n > id. */
export async function deleteCheckpointRefsAfter(
  git: GitRunner,
  dir: string,
  id: number,
): Promise<void> {
  assertCheckpointId(id);
  const { stdout } = await git(["for-each-ref", "--format=%(refname)", CHECKPOINT_REF_PREFIX], {
    cwd: dir,
  });
  for (const line of stdout.split("\n")) {
    const ref = line.trim();
    const match = CHECKPOINT_REF_PATTERN.exec(ref);
    if (match?.[1] !== undefined && Number(match[1]) > id) {
      await git(["update-ref", "-d", ref], { cwd: dir });
    }
  }
}

/** Tree sha of a commit (rev-parse <commit>^{tree}). */
export async function treeOf(git: GitRunner, dir: string, commit: string): Promise<string> {
  assertRevision(commit, "commit");
  const { stdout } = await git(["rev-parse", `${commit}^{tree}`], { cwd: dir });
  return stdout.trim();
}

/** git merge-base HEAD refs/remotes/origin/<baseBranch>. */
export async function mergeBaseWith(
  git: GitRunner,
  dir: string,
  baseBranch: string,
): Promise<string> {
  assertRevision(baseBranch, "base branch");
  const { stdout } = await git(["merge-base", "HEAD", `refs/remotes/origin/${baseBranch}`], {
    cwd: dir,
  });
  return stdout.trim();
}

/**
 * Makes the working tree identical to the snapshot; ignored files untouched; the real index is reset to HEAD.
 * Removes tracked and untracked (non-ignored) files that are not in the snapshot, and the directories they leave empty.
 */
export async function restoreWorkingTree(
  git: GitRunner,
  dir: string,
  commit: string,
): Promise<void> {
  assertRevision(commit, "commit");

  const current = await listNames(git, dir, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const wanted = new Set(await listNames(git, dir, ["ls-tree", "-r", "-z", "--name-only", commit]));

  const stale = [...new Set(current)].filter((name) => !wanted.has(name));
  // Validate every path before deleting anything.
  for (const name of stale) {
    assertInsideWorkTree(dir, name);
  }

  const emptiedDirs = new Set<string>();
  for (const name of stale) {
    try {
      const path = join(dir, name);
      // ls-files lists an untracked nested repository as a directory: remove it whole.
      if ((await lstat(path)).isDirectory()) {
        await rm(path, { recursive: true, force: true });
      } else {
        await unlink(path);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    let parent = dirname(name);
    while (parent !== "." && parent !== "" && parent !== "/") {
      emptiedDirs.add(parent);
      parent = dirname(parent);
    }
  }
  // Deepest first, so a parent directory can become empty after its children are removed.
  const deepestFirst = [...emptiedDirs].sort((a, b) => depth(b) - depth(a));
  for (const relDir of deepestFirst) {
    await removeIfEmpty(join(dir, relDir));
  }

  const indexFile = temporaryIndexPath(dir);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(["read-tree", commit], { cwd: dir, env });
    await git(["checkout-index", "-a", "-f"], { cwd: dir, env });
  } finally {
    await rm(indexFile, { force: true });
  }

  await git(["reset", "-q"], { cwd: dir });
}

/** Diff from `from` (commit or tree) to the current working tree snapshot. */
export async function diffWorkingTree(
  git: GitRunner,
  dir: string,
  from: string,
  options?: { maxPatchBytes?: number },
): Promise<{ files: DiffFile[]; patch: string; truncated: boolean }> {
  assertRevision(from, "diff source");
  const maxPatchBytes = options?.maxPatchBytes ?? DIFF_PATCH_MAX_BYTES;
  if (!Number.isSafeInteger(maxPatchBytes) || maxPatchBytes < 0) {
    throw new RangeError(`invalid maxPatchBytes: ${maxPatchBytes}`);
  }

  const tree = await snapshotTree(git, dir);
  const range = [from, tree];

  const { stdout: rawPatch } = await git(
    ["diff", "--no-color", "--no-ext-diff", "--find-renames", ...range],
    { cwd: dir },
  );
  const { stdout: nameStatus } = await git(
    ["diff", "--name-status", "-z", "--find-renames", ...range],
    { cwd: dir },
  );
  const { stdout: numstat } = await git(["diff", "--numstat", "-z", "--find-renames", ...range], {
    cwd: dir,
  });

  const counts = parseNumstat(numstat);
  const files = parseNameStatus(nameStatus).map((entry): DiffFile => {
    const count = counts.get(entry.path);
    const file: DiffFile = {
      path: entry.path,
      status: entry.status,
      additions: count?.additions ?? null,
      deletions: count?.deletions ?? null,
    };
    if (entry.oldPath !== undefined) {
      file.oldPath = entry.oldPath;
    }
    return file;
  });

  const { patch, truncated } = limitPatch(rawPatch, maxPatchBytes);
  return { files, patch, truncated };
}

/** Cuts the patch at the last "\n" before maxBytes (UTF-8 bytes). */
function limitPatch(patch: string, maxBytes: number): { patch: string; truncated: boolean } {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return { patch, truncated: false };
  }
  const head = bytes.subarray(0, maxBytes).toString("utf8");
  const lastNewline = head.lastIndexOf("\n");
  return { patch: lastNewline === -1 ? "" : head.slice(0, lastNewline + 1), truncated: true };
}

interface NameStatusEntry {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
}

/** Parses `git diff --name-status -z`: `M\0path\0`, `R<score>\0old\0new\0`. */
function parseNameStatus(output: string): NameStatusEntry[] {
  const tokens = output.split("\0");
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++] ?? "";
    if (code === "") {
      continue;
    }
    const letter = code.charAt(0);
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++] ?? "";
      const path = tokens[i++] ?? "";
      // Copies are not requested, so "C" is handled like a new file.
      entries.push(
        letter === "R" ? { path, oldPath, status: "renamed" } : { path, status: "added" },
      );
    } else {
      const path = tokens[i++] ?? "";
      entries.push({ path, status: statusOf(letter) });
    }
  }
  return entries;
}

function statusOf(letter: string): DiffFileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    default:
      // M, T (type change) and anything unexpected.
      return "modified";
  }
}

interface NumstatCount {
  additions: number | null;
  deletions: number | null;
}

/**
 * Parses `git diff --numstat -z`: `adds\tdels\tpath\0`; for renames `adds\tdels\t\0old\0new\0`.
 * Binary files have "-" counts. The map is keyed by the (new) path.
 */
function parseNumstat(output: string): Map<string, NumstatCount> {
  const tokens = output.split("\0");
  const counts = new Map<string, NumstatCount>();
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++] ?? "";
    if (record === "") {
      continue;
    }
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    const additions = parseCount(record.slice(0, firstTab));
    const deletions = parseCount(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    if (path === "") {
      // Rename: the old path follows, then the new path.
      i++;
      path = tokens[i++] ?? "";
    }
    counts.set(path, { additions, deletions });
  }
  return counts;
}

function parseCount(text: string): number | null {
  return text === "-" ? null : Number.parseInt(text, 10);
}

async function resolveHead(git: GitRunner, dir: string): Promise<string | null> {
  try {
    const { stdout } = await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: dir });
    return stdout.trim();
  } catch (error) {
    // `rev-parse -q` exits with 1 when HEAD does not resolve (e.g. no commits yet).
    if (error instanceof GitError && error.exitCode === 1) {
      return null;
    }
    throw error;
  }
}

async function listNames(git: GitRunner, dir: string, args: string[]): Promise<string[]> {
  const { stdout } = await git(args, { cwd: dir });
  return stdout
    .split("\0")
    .filter((name) => name !== "")
    .map((name) => (name.endsWith("/") ? name.slice(0, -1) : name));
}

/** Throws unless `name` resolves to a path strictly inside dir and outside any .git directory. */
function assertInsideWorkTree(dir: string, name: string): void {
  const rel = relative(dir, resolve(dir, name));
  const segments = rel.split(sep);
  if (rel === "" || isAbsolute(rel) || segments[0] === ".." || segments.includes(".git")) {
    throw new Error("refusing to touch a path outside the workspace");
  }
}

/** Removes a directory only if it is empty; a non-empty one (e.g. with ignored files) is kept. */
async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      !isNodeError(error) ||
      (error.code !== "ENOTEMPTY" && error.code !== "EEXIST" && error.code !== "ENOENT")
    ) {
      throw error;
    }
  }
}

function depth(relPath: string): number {
  return relPath.split("/").length;
}

function temporaryIndexPath(dir: string): string {
  return join(dir, ".git", `cna-index-${randomUUID()}`);
}

function assertCheckpointId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new RangeError(`invalid checkpoint id: ${String(id)}`);
  }
}

/** Refs and paths passed to git must not be empty or look like options. */
function assertRevision(value: string, label: string): void {
  if (value === "" || value.startsWith("-")) {
    throw new Error(`invalid ${label} "${value}"`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
