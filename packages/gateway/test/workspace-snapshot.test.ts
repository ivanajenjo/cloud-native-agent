import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitRunner, type GitRunner } from "../src/workspace/git.js";
import {
  CHECKPOINT_REF_PREFIX,
  deleteCheckpointRefsAfter,
  diffWorkingTree,
  mergeBaseWith,
  restoreWorkingTree,
  SNAPSHOT_IDENTITY,
  saveCheckpointRef,
  snapshotTree,
  snapshotWorkingTree,
  treeOf,
} from "../src/workspace/snapshot.js";

/** Isolated from the machine's git config. No identity: the snapshot code must not need one. */
const BASE_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && !/^(GIT_AUTHOR_|GIT_COMMITTER_|EMAIL$)/.test(entry[0]),
  ),
);
BASE_ENV.GIT_CONFIG_GLOBAL = "/dev/null";
BASE_ENV.GIT_CONFIG_NOSYSTEM = "1";

/** Runner for the snapshot code under test: no identity configured anywhere. */
const git: GitRunner = createGitRunner(BASE_ENV);

/** Runner for setting up fixtures (commits need an identity). */
const setup: GitRunner = createGitRunner({
  ...BASE_ENV,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cna-workspace-snapshot-"));
  dir = join(root, "repo");
  await mkdir(dir);
  await setup(["init", "--initial-branch=main"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "one\n");
  await writeFile(join(dir, ".gitignore"), "*.log\n");
  await setup(["add", "."], { cwd: dir });
  await setup(["commit", "-m", "initial"], { cwd: dir });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(args: string[], cwd = dir): Promise<string> {
  const { stdout } = await git(args, { cwd });
  return stdout;
}

async function head(): Promise<string> {
  return (await run(["rev-parse", "HEAD"])).trim();
}

async function listedFiles(commit: string, cwd = dir): Promise<string[]> {
  return (await run(["ls-tree", "-r", "--name-only", "-z", commit], cwd))
    .split("\0")
    .filter((name) => name !== "");
}

describe("snapshotWorkingTree", () => {
  it("includes untracked files, excludes ignored ones, and leaves HEAD, status and branch alone", async () => {
    await writeFile(join(dir, "new.txt"), "untracked\n");
    await writeFile(join(dir, "ignored.log"), "ignored\n");
    const headBefore = await head();
    const statusBefore = await run(["status", "--porcelain"]);
    const branchBefore = await run(["rev-parse", "--abbrev-ref", "HEAD"]);

    const { commit, tree } = await snapshotWorkingTree(git, dir, "checkpoint 1");

    const files = await listedFiles(commit);
    expect(files).toContain("new.txt");
    expect(files).toContain("a.txt");
    expect(files).not.toContain("ignored.log");
    expect((await run(["rev-parse", `${commit}^{tree}`])).trim()).toBe(tree);

    expect(await head()).toBe(headBefore);
    expect(await run(["status", "--porcelain"])).toBe(statusBefore);
    expect(await run(["rev-parse", "--abbrev-ref", "HEAD"])).toBe(branchBefore);
    expect((await readdir(join(dir, ".git"))).filter((n) => n.startsWith("cna-index-"))).toEqual(
      [],
    );
  });

  it("parents the snapshot on HEAD and uses the snapshot identity", async () => {
    const headBefore = await head();
    const { commit } = await snapshotWorkingTree(git, dir, "checkpoint 0");

    expect((await run(["rev-parse", `${commit}^`])).trim()).toBe(headBefore);
    const author = await run(["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", commit]);
    expect(author.trim()).toBe(
      `${SNAPSHOT_IDENTITY.name} <${SNAPSHOT_IDENTITY.email}>|${SNAPSHOT_IDENTITY.name} <${SNAPSHOT_IDENTITY.email}>|checkpoint 0`,
    );
  });

  it("creates a parentless snapshot in a repository without commits", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    await setup(["init"], { cwd: empty });
    await writeFile(join(empty, "x.txt"), "x\n");

    const { commit } = await snapshotWorkingTree(git, empty, "first");

    expect(await listedFiles(commit, empty)).toEqual(["x.txt"]);
    await expect(run(["rev-parse", `${commit}^`], empty)).rejects.toThrow();
  });
});

describe("snapshotTree", () => {
  it("equals the tree of HEAD when the working tree is clean", async () => {
    expect(await snapshotTree(git, dir)).toBe(await treeOf(git, dir, "HEAD"));
  });
});

describe("checkpoint refs", () => {
  it("saves a ref and deletes the ones after a given id", async () => {
    const { commit } = await snapshotWorkingTree(git, dir, "snap");
    for (let id = 0; id <= 3; id++) {
      await saveCheckpointRef(git, dir, id, commit);
    }
    expect(await listCheckpointRefs()).toEqual([0, 1, 2, 3]);

    await deleteCheckpointRefsAfter(git, dir, 1);

    expect(await listCheckpointRefs()).toEqual([0, 1]);
  });

  it("creates the ref under refs/cna/checkpoints/<id>", async () => {
    const { commit } = await snapshotWorkingTree(git, dir, "snap");
    await saveCheckpointRef(git, dir, 5, commit);
    expect((await run(["rev-parse", `${CHECKPOINT_REF_PREFIX}5`])).trim()).toBe(commit);
  });

  it("rejects negative and non-integer ids before calling git", async () => {
    const { commit } = await snapshotWorkingTree(git, dir, "snap");
    for (const id of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(saveCheckpointRef(git, dir, id, commit)).rejects.toThrow(RangeError);
      await expect(deleteCheckpointRefsAfter(git, dir, id)).rejects.toThrow(RangeError);
    }
    expect(await listCheckpointRefs()).toEqual([]);
  });

  async function listCheckpointRefs(): Promise<number[]> {
    const refs = (await run(["for-each-ref", "--format=%(refname)", CHECKPOINT_REF_PREFIX]))
      .split("\n")
      .filter((line) => line !== "");
    return refs.map((ref) => Number(ref.slice(CHECKPOINT_REF_PREFIX.length))).sort((a, b) => a - b);
  }
});

describe("restoreWorkingTree", () => {
  it("brings back the snapshot and removes what was created after it, keeping ignored files", async () => {
    await writeFile(join(dir, "a.txt"), "v1\n");
    await writeFile(join(dir, "b.txt"), "bee\n");
    await writeFile(join(dir, "ignored.log"), "keep\n");
    const { commit } = await snapshotWorkingTree(git, dir, "snap");

    await writeFile(join(dir, "a.txt"), "v2\n");
    await mkdir(join(dir, "sub", "new"), { recursive: true });
    await writeFile(join(dir, "sub", "new", "c.txt"), "created\n");
    await rm(join(dir, "b.txt"));
    await writeFile(join(dir, "extra.log"), "ignored and created\n");

    await restoreWorkingTree(git, dir, commit);

    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(dir, "sub", "new", "c.txt"))).toBe(false);
    expect(existsSync(join(dir, "sub"))).toBe(false);
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("bee\n");
    expect(await readFile(join(dir, "ignored.log"), "utf8")).toBe("keep\n");
    expect(await readFile(join(dir, "extra.log"), "utf8")).toBe("ignored and created\n");
    expect(await run(["diff", "--cached"])).toBe("");
  });

  it("removes an untracked nested repository created after the snapshot", async () => {
    const { commit } = await snapshotWorkingTree(git, dir, "snap");
    const nested = join(dir, "vendor", "lib");
    await mkdir(nested, { recursive: true });
    await setup(["init", "--initial-branch=main"], { cwd: nested });
    await writeFile(join(nested, "x.txt"), "x\n");

    await restoreWorkingTree(git, dir, commit);

    expect(existsSync(join(dir, "vendor"))).toBe(false);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
  });

  it("keeps directories that still contain ignored files", async () => {
    await mkdir(join(dir, "build"));
    const { commit } = await snapshotWorkingTree(git, dir, "snap");

    await writeFile(join(dir, "build", "out.txt"), "generated\n");
    await writeFile(join(dir, "build", "cache.log"), "ignored\n");

    await restoreWorkingTree(git, dir, commit);

    expect(existsSync(join(dir, "build", "out.txt"))).toBe(false);
    expect(await readFile(join(dir, "build", "cache.log"), "utf8")).toBe("ignored\n");
  });

  it("resets staged changes so the real index matches HEAD", async () => {
    const { commit } = await snapshotWorkingTree(git, dir, "snap");
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await run(["add", "staged.txt"]);

    await restoreWorkingTree(git, dir, commit);

    expect(existsSync(join(dir, "staged.txt"))).toBe(false);
    expect(await run(["diff", "--cached", "--name-only"])).toBe("");
  });

  it("keeps the executable bit of a file", async () => {
    const script = join(dir, "run.sh");
    await writeFile(script, "#!/bin/sh\necho one\n");
    await chmod(script, 0o755);
    const { commit } = await snapshotWorkingTree(git, dir, "snap");

    await writeFile(script, "changed\n");
    await chmod(script, 0o644);

    await restoreWorkingTree(git, dir, commit);

    expect(await readFile(script, "utf8")).toBe("#!/bin/sh\necho one\n");
    expect((await stat(script)).mode & 0o111).not.toBe(0);
  });
});

describe("mergeBaseWith", () => {
  it("returns the base branch commit when the work branch has its own commits", async () => {
    const remote = join(root, "remote.git");
    await setup(["clone", "--bare", dir, remote], { cwd: root });
    const clone = join(root, "clone");
    await setup(["clone", remote, clone], { cwd: root });
    const baseCommit = (await run(["rev-parse", "refs/remotes/origin/main"], clone)).trim();

    await setup(["checkout", "-b", "agent/work"], { cwd: clone });
    await writeFile(join(clone, "work.txt"), "work\n");
    await setup(["add", "work.txt"], { cwd: clone });
    await setup(["commit", "-m", "work"], { cwd: clone });

    expect(await mergeBaseWith(git, clone, "main")).toBe(baseCommit);
  });

  it("rejects a base branch that looks like an option", async () => {
    await expect(mergeBaseWith(git, dir, "-x")).rejects.toThrow(/invalid base branch/);
  });
});

describe("diffWorkingTree", () => {
  it("reports added, modified, deleted, renamed and binary files against a commit", async () => {
    await writeFile(join(dir, "keep.txt"), "keep\n");
    await writeFile(join(dir, "modify.txt"), "line1\nline2\nline3\n");
    await writeFile(join(dir, "delete.txt"), "gone\n");
    await writeFile(join(dir, "old name.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    await writeFile(join(dir, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await setup(["add", "."], { cwd: dir });
    await setup(["commit", "-m", "base"], { cwd: dir });
    const base = await head();

    await writeFile(join(dir, "modify.txt"), "line1\nCHANGED\nline3\nline4\n");
    await rm(join(dir, "delete.txt"));
    await rm(join(dir, "old name.txt"));
    await writeFile(join(dir, "moved file.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    await writeFile(join(dir, "binary.bin"), Buffer.from([0, 9, 9, 9, 0]));
    await writeFile(join(dir, "añadido ñ.txt"), "nuevo\n");
    await writeFile(join(dir, "with space.txt"), "spaced\n");
    await writeFile(join(dir, "ignored.log"), "ignored\n");

    const { files, patch, truncated } = await diffWorkingTree(git, dir, base);

    expect(truncated).toBe(false);
    expect(patch).toContain("CHANGED");
    expect(files.find((f) => f.path === "añadido ñ.txt")).toEqual({
      path: "añadido ñ.txt",
      status: "added",
      additions: 1,
      deletions: 0,
    });
    expect(files.find((f) => f.path === "with space.txt")).toEqual({
      path: "with space.txt",
      status: "added",
      additions: 1,
      deletions: 0,
    });
    expect(files.find((f) => f.path === "modify.txt")).toEqual({
      path: "modify.txt",
      status: "modified",
      additions: 2,
      deletions: 1,
    });
    expect(files.find((f) => f.path === "delete.txt")).toEqual({
      path: "delete.txt",
      status: "deleted",
      additions: 0,
      deletions: 1,
    });
    expect(files.find((f) => f.path === "moved file.txt")).toEqual({
      path: "moved file.txt",
      oldPath: "old name.txt",
      status: "renamed",
      additions: 0,
      deletions: 0,
    });
    expect(files.find((f) => f.path === "binary.bin")).toEqual({
      path: "binary.bin",
      status: "modified",
      additions: null,
      deletions: null,
    });
    expect(files.find((f) => f.path === "keep.txt")).toBeUndefined();
    expect(files.some((f) => f.path === "ignored.log")).toBe(false);
  });

  it("diffs against a checkpoint commit as well as against a branch commit", async () => {
    const { commit } = await snapshotWorkingTree(git, dir, "snap");
    await writeFile(join(dir, "later.txt"), "later\n");

    const { files } = await diffWorkingTree(git, dir, commit);

    expect(files).toEqual([{ path: "later.txt", status: "added", additions: 1, deletions: 0 }]);
  });

  it("cuts the patch at a line boundary when maxPatchBytes is small, keeping files complete", async () => {
    await writeFile(join(dir, "big.txt"), "line of text\n".repeat(200));
    await setup(["add", "big.txt"], { cwd: dir });
    await setup(["commit", "-m", "big"], { cwd: dir });
    const base = await head();
    await writeFile(join(dir, "a.txt"), "changed\n".repeat(50));

    const full = await diffWorkingTree(git, dir, base);
    const cut = await diffWorkingTree(git, dir, base, { maxPatchBytes: 120 });

    expect(full.truncated).toBe(false);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.patch, "utf8")).toBeLessThanOrEqual(120);
    expect(cut.patch.endsWith("\n")).toBe(true);
    expect(full.patch.startsWith(cut.patch)).toBe(true);
    expect(cut.files).toEqual(full.files);
  });

  it("does not leave temporary index files behind", async () => {
    await writeFile(join(dir, "x.txt"), "x\n");
    await diffWorkingTree(git, dir, await head());
    expect((await readdir(join(dir, ".git"))).filter((n) => n.startsWith("cna-index-"))).toEqual(
      [],
    );
  });
});
