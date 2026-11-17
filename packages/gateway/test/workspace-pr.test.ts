import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitRunner } from "../src/workspace/git.js";
import {
  createGhRunner,
  type GhRunner,
  PullRequestError,
  type PullRequestInfo,
  preparePrWorkspace,
  resolvePullRequest,
} from "../src/workspace/pr.js";

/** Isolated from the machine's git config; identity only for the commits made by the helpers. */
const TEST_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const git = createGitRunner(TEST_ENV);

const PR_VIEW_FIELDS = "number,state,isCrossRepository,headRefName,baseRefName";

interface PrView {
  number?: number;
  state?: string;
  isCrossRepository?: boolean;
  headRefName?: string;
  baseRefName?: string;
}

/** A GhRunner that answers `gh pr view` with the given JSON and records the calls. */
function fakeGh(view: PrView) {
  const calls: { args: string[]; cwd: string }[] = [];
  const gh: GhRunner = async (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return { stdout: JSON.stringify(view), stderr: "" };
  };
  return { gh, calls };
}

const OPEN_AGENT_PR: PrView = {
  number: 12,
  state: "OPEN",
  isCrossRepository: false,
  headRefName: "agent/fix",
  baseRefName: "main",
};

describe("resolvePullRequest", () => {
  it("resolves an open same-repo PR from an agent/* branch and runs the exact gh command", async () => {
    const { gh, calls } = fakeGh(OPEN_AGENT_PR);

    const info = await resolvePullRequest(gh, "octo/x", 12, "/tmp/some-cwd");

    expect(info).toEqual({ number: 12, headBranch: "agent/fix", baseBranch: "main" });
    expect(calls).toEqual([
      {
        args: ["pr", "view", "12", "--repo", "octo/x", "--json", PR_VIEW_FIELDS],
        cwd: "/tmp/some-cwd",
      },
    ]);
  });

  it("rejects when gh fails, with a message that includes the gh message", async () => {
    const gh: GhRunner = async () => {
      throw new Error("gh pr failed: Could not resolve to a PullRequest");
    };

    const error = await resolvePullRequest(gh, "octo/x", 12, "/tmp").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PullRequestError);
    expect((error as Error).message).toBe(
      "pull request #12 not found or not accessible: gh pr failed: Could not resolve to a PullRequest",
    );
  });

  it("rejects when the output is not the expected JSON", async () => {
    const gh: GhRunner = async () => ({ stdout: "not json {", stderr: "" });
    await expect(resolvePullRequest(gh, "octo/x", 12, "/tmp")).rejects.toThrow(PullRequestError);

    const wrongShape: GhRunner = async () => ({ stdout: '{"number":"12"}', stderr: "" });
    await expect(resolvePullRequest(wrongShape, "octo/x", 12, "/tmp")).rejects.toThrow(
      PullRequestError,
    );
  });

  it("rejects a closed PR", async () => {
    const { gh } = fakeGh({ ...OPEN_AGENT_PR, state: "CLOSED" });
    await expect(resolvePullRequest(gh, "octo/x", 12, "/tmp")).rejects.toThrow(
      "pull request #12 is closed",
    );
  });

  it("rejects a merged PR", async () => {
    const { gh } = fakeGh({ ...OPEN_AGENT_PR, state: "MERGED" });
    await expect(resolvePullRequest(gh, "octo/x", 12, "/tmp")).rejects.toThrow(
      "pull request #12 is merged",
    );
  });

  it("rejects a PR from a fork", async () => {
    const { gh } = fakeGh({ ...OPEN_AGENT_PR, isCrossRepository: true });
    await expect(resolvePullRequest(gh, "octo/x", 12, "/tmp")).rejects.toThrow(
      "pull request #12 comes from a fork",
    );
  });

  it("rejects a PR whose head branch is not agent/*", async () => {
    const { gh } = fakeGh({ ...OPEN_AGENT_PR, headRefName: "feature/x" });
    await expect(resolvePullRequest(gh, "octo/x", 12, "/tmp")).rejects.toThrow(
      "pull request #12 is not from an agent/* branch",
    );
  });

  it("rejects a PR whose head is the base branch", async () => {
    const { gh } = fakeGh({ ...OPEN_AGENT_PR, headRefName: "agent/x", baseRefName: "agent/x" });
    await expect(resolvePullRequest(gh, "octo/x", 12, "/tmp")).rejects.toThrow(PullRequestError);
  });
});

describe("preparePrWorkspace", () => {
  let root: string;
  let remoteDir: string;
  let remoteBase: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cna-workspace-pr-"));

    // Source repo: main with an initial commit, and agent/fix with one extra commit.
    const source = join(root, "source");
    await mkdir(source);
    await git(["init", "--initial-branch=main"], { cwd: source });
    await writeFile(join(source, "README.md"), "hello\n");
    await git(["add", "README.md"], { cwd: source });
    await git(["commit", "-m", "initial"], { cwd: source });
    await git(["checkout", "-b", "agent/fix"], { cwd: source });
    await writeFile(join(source, "FIX.md"), "fix\n");
    await git(["add", "FIX.md"], { cwd: source });
    await git(["commit", "-m", "agent fix work"], { cwd: source });
    await git(["checkout", "main"], { cwd: source });

    // Bare "remote" at <root>/remote/octo/hello.git.
    await mkdir(join(root, "remote", "octo"), { recursive: true });
    remoteDir = join(root, "remote", "octo", "hello.git");
    await git(["clone", "--bare", source, remoteDir], { cwd: root });
    remoteBase = `${pathToFileURL(join(root, "remote")).href}/`;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function workspaceDir(name = "ws"): string {
    return join(root, "workspaces", name);
  }

  function prInfo(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
    return { number: 12, headBranch: "agent/fix", baseBranch: "main", ...overrides };
  }

  it("clones the PR head branch with tracking and sets the base and identity", async () => {
    const dir = workspaceDir();
    const result = await preparePrWorkspace({
      git,
      repo: "octo/hello",
      dir,
      pr: prInfo(),
      userName: "Agent Bot",
      userEmail: "agent@example.test",
      remoteBase,
    });

    expect(result).toEqual({ baseBranch: "main", branch: "agent/fix" });

    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
    expect(head.stdout.trim()).toBe("agent/fix");

    const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: dir,
    });
    expect(upstream.stdout.trim()).toBe("origin/agent/fix");

    expect(await readFile(join(dir, "FIX.md"), "utf8")).toBe("fix\n");
    await git(["rev-parse", "--verify", "refs/remotes/origin/main"], { cwd: dir });

    const name = await git(["config", "user.name"], { cwd: dir });
    const email = await git(["config", "user.email"], { cwd: dir });
    expect(name.stdout.trim()).toBe("Agent Bot");
    expect(email.stdout.trim()).toBe("agent@example.test");
  });

  it("keeps the remote URL without credentials", async () => {
    const dir = workspaceDir();
    await preparePrWorkspace({
      git,
      repo: "octo/hello",
      dir,
      pr: prInfo(),
      remoteBase,
    });

    const { stdout } = await git(["config", "--get", "remote.origin.url"], { cwd: dir });
    expect(stdout.trim()).toBe(`${remoteBase}octo/hello.git`);
    expect(stdout).not.toContain("@");
  });

  it.each([
    ["-x", "main"],
    ["agent/fix", "-x"],
    ["a..b", "main"],
    ["agent/fix", "a..b"],
  ])("rejects invalid branch names (head %s, base %s) before cloning", async (head, base) => {
    const dir = workspaceDir();
    await expect(
      preparePrWorkspace({
        git,
        repo: "octo/hello",
        dir,
        pr: prInfo({ headBranch: head, baseBranch: base }),
        remoteBase,
      }),
    ).rejects.toThrow(/invalid branch name/);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("createGhRunner", () => {
  let root: string;
  let binDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cna-workspace-gh-"));
    binDir = join(root, "bin");
    await mkdir(binDir);
    // Fake gh: prints its args and the variables we set; "fail" exits 1 with a two-line stderr.
    const script = [
      "#!/bin/sh",
      'for a in "$@"; do printf \'ARG=%s\\n\' "$a"; done',
      "printf 'PROMPT=%s\\n' \"$GH_PROMPT_DISABLED\"",
      "printf 'NOCOLOR=%s\\n' \"$NO_COLOR\"",
      "printf 'UPDATE=%s\\n' \"$GH_NO_UPDATE_NOTIFIER\"",
      'if [ "$1" = "fail" ]; then',
      '  echo "could not find the thing" >&2',
      '  echo "second line" >&2',
      "  exit 1",
      "fi",
      "",
    ].join("\n");
    const scriptPath = join(binDir, "gh");
    await writeFile(scriptPath, script);
    await chmod(scriptPath, 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runnerWithFakeGh(extra: Record<string, string | undefined> = {}) {
    return createGhRunner({
      ...(process.env as Record<string, string>),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ...extra,
    });
  }

  it("runs gh with the given args, in cwd, with the non-interactive variables", async () => {
    const gh = runnerWithFakeGh();
    const { stdout } = await gh(["pr", "view", "12"], { cwd: root });

    expect(stdout).toContain("ARG=pr\n");
    expect(stdout).toContain("ARG=view\n");
    expect(stdout).toContain("ARG=12\n");
    expect(stdout).toContain("PROMPT=1\n");
    expect(stdout).toContain("NOCOLOR=1\n");
    expect(stdout).toContain("UPDATE=1\n");
  });

  it("rejects with the first stderr line and never includes env values", async () => {
    const gh = runnerWithFakeGh({ GITHUB_TOKEN: "secreto123" });

    const error = await gh(["fail", "x"], { cwd: root }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("gh fail failed: could not find the thing");
    expect((error as Error).message).not.toContain("secreto123");
  });
});
