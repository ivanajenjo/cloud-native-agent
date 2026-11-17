import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGitRunner,
  GH_CREDENTIAL_HELPER,
  GitError,
  gitEnv,
  prepareResumeWorkspace,
  prepareWorkspace,
  slugify,
  workspaceState,
} from "../src/workspace/git.js";

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

let root: string;
let remoteDir: string;
let remoteBase: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cna-workspace-git-"));

  // Source repo with main (initial commit) and develop (one extra file).
  const source = join(root, "source");
  await mkdir(source);
  await git(["init", "--initial-branch=main"], { cwd: source });
  await writeFile(join(source, "README.md"), "hello\n");
  await git(["add", "README.md"], { cwd: source });
  await git(["commit", "-m", "initial"], { cwd: source });
  await git(["branch", "develop"], { cwd: source });
  await git(["checkout", "develop"], { cwd: source });
  await writeFile(join(source, "DEVELOP.md"), "develop\n");
  await git(["add", "DEVELOP.md"], { cwd: source });
  await git(["commit", "-m", "develop work"], { cwd: source });
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

async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  return stdout.trim();
}

describe("slugify", () => {
  it("transliterates accents and joins words with dashes", () => {
    expect(slugify("Añade tests al parser JSON!")).toBe("anade-tests-al-parser-json");
  });

  it("returns task when nothing usable is left", () => {
    expect(slugify("¡¡¡ ??? ### ")).toBe("task");
    expect(slugify("")).toBe("task");
    expect(slugify("日本語のみ")).toBe("task");
  });

  it("keeps at most 40 chars and never ends with a dash", () => {
    const slug = slugify("refactorizar el sistema de autenticación completo del servicio de pagos");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("refactorizar-el-sistema")).toBe(true);

    const longWord = slugify(`a${"b".repeat(60)} c`);
    expect(longWord.length).toBeLessThanOrEqual(40);
    expect(longWord.endsWith("-")).toBe(false);
  });

  it("uses only the first 6 words", () => {
    expect(slugify("uno dos tres cuatro cinco seis siete ocho")).toBe(
      "uno-dos-tres-cuatro-cinco-seis",
    );
  });
});

describe("prepareWorkspace", () => {
  it("clones the default branch and creates agent/<slug> checked out", async () => {
    const dir = workspaceDir();
    const result = await prepareWorkspace({
      git,
      repo: "octo/hello",
      dir,
      slug: "fix-readme",
      remoteBase,
    });

    expect(result).toEqual({ baseBranch: "main", branch: "agent/fix-readme" });
    expect(await currentBranch(dir)).toBe("agent/fix-readme");
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(dir, "DEVELOP.md"))).toBe(false);
  });

  it("branches from the requested base branch", async () => {
    const dir = workspaceDir();
    const result = await prepareWorkspace({
      git,
      repo: "octo/hello",
      baseBranch: "develop",
      dir,
      slug: "feature",
      remoteBase,
    });

    expect(result).toEqual({ baseBranch: "develop", branch: "agent/feature" });
    expect(await currentBranch(dir)).toBe("agent/feature");
    expect(await readFile(join(dir, "DEVELOP.md"), "utf8")).toBe("develop\n");
  });

  it("adds a numeric suffix when agent/<slug> already exists on the remote", async () => {
    const source = join(root, "source");
    await git(["push", remoteDir, "main:refs/heads/agent/fix"], { cwd: source });
    await git(["push", remoteDir, "main:refs/heads/agent/fix-2"], { cwd: source });

    const dir = workspaceDir();
    const result = await prepareWorkspace({
      git,
      repo: "octo/hello",
      dir,
      slug: "fix",
      remoteBase,
    });

    expect(result.branch).toBe("agent/fix-3");
    expect(await currentBranch(dir)).toBe("agent/fix-3");
  });

  it("writes the gh credential helper to .git/config without credentials in the URL", async () => {
    const dir = workspaceDir();
    const url = `${remoteBase}octo/hello.git`;
    await prepareWorkspace({
      git,
      repo: "octo/hello",
      dir,
      slug: "auth",
      remoteBase,
    });

    const config = await readFile(join(dir, ".git", "config"), "utf8");
    expect(config).toContain(`helper = ${GH_CREDENTIAL_HELPER}`);
    expect(config).toContain("helper = \n");

    const { stdout } = await git(["config", "--get", "remote.origin.url"], { cwd: dir });
    expect(stdout.trim()).toBe(url);
    expect(stdout).not.toContain("@");
  });

  it("does not persist the token from the runner env into the clone", async () => {
    const secret = "ghp_thisIsNotARealTokenXYZ";
    const runner = createGitRunner({ ...TEST_ENV, GITHUB_TOKEN: secret, GH_TOKEN: secret });
    const dir = workspaceDir();
    await prepareWorkspace({ git: runner, repo: "octo/hello", dir, slug: "x", remoteBase });

    const config = await readFile(join(dir, ".git", "config"), "utf8");
    expect(config).not.toContain(secret);
  });

  it("sets the commit identity in the clone", async () => {
    const dir = workspaceDir();
    await prepareWorkspace({
      git,
      repo: "octo/hello",
      dir,
      slug: "identity",
      userName: "Agent Bot",
      userEmail: "agent@example.test",
      remoteBase,
    });

    const name = await git(["config", "user.name"], { cwd: dir });
    const email = await git(["config", "user.email"], { cwd: dir });
    expect(name.stdout.trim()).toBe("Agent Bot");
    expect(email.stdout.trim()).toBe("agent@example.test");
  });

  it("accepts an existing empty directory", async () => {
    await mkdir(workspaceDir(), { recursive: true });
    const result = await prepareWorkspace({
      git,
      repo: "octo/hello",
      dir: workspaceDir(),
      slug: "empty-dir",
      remoteBase,
    });
    expect(result.branch).toBe("agent/empty-dir");
  });

  it("rejects an invalid base branch before touching the disk", async () => {
    for (const baseBranch of ["bad..name", "-x"]) {
      const dir = workspaceDir(`bad-${baseBranch.length}`);
      await expect(
        prepareWorkspace({ git, repo: "octo/hello", baseBranch, dir, slug: "s", remoteBase }),
      ).rejects.toThrow(/invalid base branch/);
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("rejects a non-empty workspace directory", async () => {
    const dir = workspaceDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "leftover.txt"), "x");

    await expect(
      prepareWorkspace({ git, repo: "octo/hello", dir, slug: "s", remoteBase }),
    ).rejects.toThrow("workspace not empty");
  });

  it("fails with GitError when the base branch does not exist", async () => {
    const error = await prepareWorkspace({
      git,
      repo: "octo/hello",
      baseBranch: "no-such-branch",
      dir: workspaceDir(),
      slug: "s",
      remoteBase,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitError);
  });
});

describe("createGitRunner", () => {
  it("rejects with GitError carrying exit code, args and stderr when git fails", async () => {
    const error = await git(["no-such-subcommand"], { cwd: root }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitError);
    const gitError = error as GitError;
    expect(gitError.exitCode).toBe(1);
    expect(gitError.args).toEqual(["no-such-subcommand"]);
    expect(gitError.stderr).toContain("no-such-subcommand");
  });

  it("truncates stderr to 2000 chars", async () => {
    const error = await git([`bogus-${"a".repeat(5000)}`], { cwd: root }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).stderr.length).toBeLessThanOrEqual(2000);
  });

  it("returns stdout and stderr on success", async () => {
    const result = await git(["--version"], { cwd: root });
    expect(result.stdout).toMatch(/^git version /);
  });
});

describe("GitRunner env option", () => {
  it("passes the per-call env to the git process without changing the base env", async () => {
    const repo = join(root, "env-repo");
    await mkdir(repo);
    await git(["init"], { cwd: repo });
    await writeFile(join(repo, "tracked.txt"), "x\n");
    await git(["add", "tracked.txt"], { cwd: repo });

    // An empty alternative index: git ls-files must see it instead of the real one.
    const altIndex = join(root, "alt-index");
    await git(["read-tree", "--empty"], { cwd: repo, env: { GIT_INDEX_FILE: altIndex } });

    const withEnv = await git(["ls-files"], { cwd: repo, env: { GIT_INDEX_FILE: altIndex } });
    const withoutEnv = await git(["ls-files"], { cwd: repo });

    expect(withEnv.stdout).toBe("");
    expect(withoutEnv.stdout.trim()).toBe("tracked.txt");
  });
});

describe("gitEnv", () => {
  it("always sets GIT_TERMINAL_PROMPT=0, overriding the caller", () => {
    expect(gitEnv({ GIT_TERMINAL_PROMPT: "1" }).GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitEnv({})).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });

  it("drops undefined values and keeps the rest", () => {
    expect(gitEnv({ A: "1", B: undefined })).toEqual({ A: "1", GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("workspaceState", () => {
  async function cloneWorkspace(): Promise<string> {
    const dir = workspaceDir();
    await prepareWorkspace({
      git,
      repo: "octo/hello",
      dir,
      slug: "state",
      remoteBase,
    });
    return dir;
  }

  async function commitFile(dir: string, name: string): Promise<void> {
    await writeFile(join(dir, name), `${name}\n`);
    await git(["add", name], { cwd: dir });
    await git(["commit", "-m", `add ${name}`], { cwd: dir });
  }

  it("is clean for a freshly cloned workspace", async () => {
    const dir = await cloneWorkspace();
    expect(await workspaceState(git, dir, { checkUnpushed: true })).toBe("clean");
  });

  it("is uncommitted when there is an untracked file", async () => {
    const dir = await cloneWorkspace();
    await writeFile(join(dir, "new.txt"), "x\n");
    expect(await workspaceState(git, dir, { checkUnpushed: true })).toBe("uncommitted");
  });

  it("is unpushed when there is a commit not on the remote", async () => {
    const dir = await cloneWorkspace();
    await commitFile(dir, "local.txt");
    expect(await workspaceState(git, dir, { checkUnpushed: true })).toBe("unpushed");
  });

  it("is clean once the branch has been pushed", async () => {
    const dir = await cloneWorkspace();
    await commitFile(dir, "local.txt");
    await git(["push", "origin", "HEAD"], { cwd: dir });
    expect(await workspaceState(git, dir, { checkUnpushed: true })).toBe("clean");
  });

  it("is clean when the directory has no .git", async () => {
    const dir = join(root, "plain");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "file.txt"), "x\n");
    expect(await workspaceState(git, dir, { checkUnpushed: true })).toBe("clean");
  });

  it("ignores unpushed commits when checkUnpushed is false", async () => {
    const dir = await cloneWorkspace();
    await commitFile(dir, "local.txt");
    expect(await workspaceState(git, dir, { checkUnpushed: false })).toBe("clean");
  });

  it("rejects when git fails", async () => {
    const dir = join(root, "plain-with-git");
    await mkdir(join(dir, ".git"), { recursive: true });
    await expect(workspaceState(git, dir, { checkUnpushed: false })).rejects.toThrow(GitError);
  });
});

describe("prepareResumeWorkspace", () => {
  it("checks out the existing remote branch with tracking and its commits", async () => {
    // The session's branch already exists on the remote: "develop work" lives there, not on main.
    const source = join(root, "source");
    await git(["push", remoteDir, "develop:refs/heads/agent/resume"], { cwd: source });

    const dir = workspaceDir();
    const result = await prepareResumeWorkspace({
      git,
      repo: "octo/hello",
      dir,
      branch: "agent/resume",
      baseBranch: "main",
      remoteBase,
    });

    expect(result).toEqual({ baseBranch: "main", branch: "agent/resume" });
    expect(await currentBranch(dir)).toBe("agent/resume");
    const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: dir,
    });
    expect(upstream.stdout.trim()).toBe("origin/agent/resume");
    const subject = await git(["log", "-1", "--format=%s"], { cwd: dir });
    expect(subject.stdout.trim()).toBe("develop work");
    expect(existsSync(join(dir, "DEVELOP.md"))).toBe(true);
  });

  it("creates the branch from the base when it does not exist on the remote", async () => {
    const dir = workspaceDir();
    const result = await prepareResumeWorkspace({
      git,
      repo: "octo/hello",
      dir,
      branch: "agent/never-pushed",
      baseBranch: "main",
      remoteBase,
    });

    expect(result).toEqual({ baseBranch: "main", branch: "agent/never-pushed" });
    expect(await currentBranch(dir)).toBe("agent/never-pushed");
    const subject = await git(["log", "-1", "--format=%s"], { cwd: dir });
    expect(subject.stdout.trim()).toBe("initial");
    expect(existsSync(join(dir, "DEVELOP.md"))).toBe(false);
  });

  it("rejects branches outside agent/* and the base branch itself", async () => {
    for (const branch of ["main", "feature/x"]) {
      const dir = workspaceDir(`resume-${branch.replace("/", "-")}`);
      const error = await prepareResumeWorkspace({
        git,
        repo: "octo/hello",
        dir,
        branch,
        baseBranch: "main",
        remoteBase,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GitError);
      expect(existsSync(dir)).toBe(false);
    }

    await expect(
      prepareResumeWorkspace({
        git,
        repo: "octo/hello",
        dir: workspaceDir("resume-same"),
        branch: "agent/main",
        baseBranch: "agent/main",
        remoteBase,
      }),
    ).rejects.toThrow(/base branch/);
  });
});
