import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gitExtension from "../src/git.js";

interface ToolResult {
  content: { type: string; text: string }[];
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<ToolResult>;
}

type Flags = Record<string, string | boolean | undefined>;

/** Identity and config isolation for every git process started by the tests. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "CNA Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "CNA Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

/** Runs a command for real, the way pi.exec does: no shell, captured output. */
function runProcess(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout,
        env: GIT_ENV,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code,
          killed: error?.killed ?? false,
          truncated: false,
        });
      },
    );
  });
}

type GhFake = (args: string[], options?: ExecOptions) => ExecResult;

/** Default simulated gh: creates the pull request and prints its URL. Never runs gh. */
const GH_SUCCESS: GhFake = () => ({
  stdout: "Creating pull request for agent/test into main\nhttps://github.com/owner/repo/pull/7\n",
  stderr: "",
  code: 0,
  killed: false,
  truncated: false,
});

function fakePi(flags: Flags, gh: GhFake = GH_SUCCESS) {
  let registered: CapturedTool[] = [];
  // Git runs for real against the local repository; gh is simulated, never executed.
  const exec = vi.fn((command: string, args: string[], options?: ExecOptions) =>
    command === "gh" ? Promise.resolve(gh(args, options)) : runProcess(command, args, options),
  );
  const pi = {
    registerTool: vi.fn((definition: unknown) => {
      registered = [...registered, definition as CapturedTool];
    }),
    registerFlag: vi.fn(),
    getFlag: vi.fn((name: string) => flags[name]),
    exec,
  };
  gitExtension(pi as unknown as ExtensionAPI);
  const tool = (name: string): CapturedTool => {
    const found = registered.find((t) => t.name === name);
    if (found === undefined) throw new Error(`tool ${name} not registered`);
    return found;
  };
  return { pi, exec, tool, registered: () => registered };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

describe("git extension", () => {
  let root: string;
  let work: string;
  let remote: string;
  let flags: Flags;
  let confirm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cna-git-"));
    work = join(root, "work");
    remote = join(root, "origin.git");
    git(root, ["init", "-q", "--bare", remote]);
    git(root, ["init", "-q", "-b", "main", work]);
    writeFileSync(join(work, "README.md"), "# test\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "chore: initial commit"]);
    git(work, ["remote", "add", "origin", remote]);
    git(work, ["push", "-q", "origin", "main"]);
    git(work, ["checkout", "-q", "-b", "agent/test"]);
    flags = { "cna-base-branch": "main", "cna-auto-push": false };
    confirm = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function context() {
    return {
      cwd: work,
      ui: {
        select: vi.fn(),
        input: vi.fn(),
        editor: vi.fn(),
        confirm,
      },
    };
  }

  function setup(gh?: GhFake) {
    const fake = fakePi(flags, gh);
    const ctx = context();
    const run = (name: string, params: Record<string, unknown> = {}) =>
      fake.tool(name).execute("call-1", params, undefined, undefined, ctx);
    return { ...fake, ctx, run };
  }

  describe("registration", () => {
    it("registers the flags and the four tools", () => {
      const { pi, registered } = setup();
      expect(pi.registerFlag).toHaveBeenCalledWith(
        "cna-base-branch",
        expect.objectContaining({ type: "string" }),
      );
      expect(pi.registerFlag).toHaveBeenCalledWith(
        "cna-auto-push",
        expect.objectContaining({ type: "boolean", default: false }),
      );
      expect(registered().map((t) => t.name)).toEqual([
        "git_status",
        "git_commit",
        "git_push",
        "create_pr",
      ]);
    });

    it("names each tool in its prompt guidelines", () => {
      const { registered } = setup();
      for (const tool of registered()) {
        const guidelines = tool.promptGuidelines ?? [];
        expect(guidelines.length).toBeGreaterThan(0);
        for (const guideline of guidelines) {
          expect(guideline).toContain(tool.name);
        }
      }
    });
  });

  describe("git_status", () => {
    it("reports a clean working tree", async () => {
      const { run } = setup();

      const result = await run("git_status");

      expect(result.details).toEqual({ branch: "agent/test", clean: true });
      expect(result.content[0]?.text).toContain("Working tree clean.");
    });

    it("reports an untracked file", async () => {
      writeFileSync(join(work, "new.txt"), "x\n");
      const { run } = setup();

      const result = await run("git_status");

      expect(result.details).toEqual({ branch: "agent/test", clean: false });
      expect(result.content[0]?.text).toContain("?? new.txt");
    });
  });

  describe("git_commit", () => {
    it("commits all changes on an agent branch", async () => {
      writeFileSync(join(work, "feature.txt"), "feature\n");
      const { run } = setup();

      const result = await run("git_commit", { message: "feat: add feature" });

      const commit = git(work, ["rev-parse", "--short", "HEAD"]);
      expect(result.details).toEqual({ branch: "agent/test", commit });
      expect(git(work, ["log", "-1", "--format=%s"])).toBe("feat: add feature");
      expect(git(work, ["status", "--porcelain"])).toBe("");
    });

    it("commits only the given paths", async () => {
      writeFileSync(join(work, "a.txt"), "a\n");
      writeFileSync(join(work, "b.txt"), "b\n");
      const { run } = setup();

      await run("git_commit", { message: "feat: add a", paths: ["a.txt"] });

      expect(git(work, ["show", "--name-only", "--format=", "HEAD"])).toBe("a.txt");
      expect(git(work, ["status", "--porcelain"])).toBe("?? b.txt");
    });

    it("fails with 'Nothing to commit' when nothing changed", async () => {
      const { run } = setup();

      await expect(run("git_commit", { message: "empty" })).rejects.toThrow("Nothing to commit");
    });

    it("refuses to commit on the base branch", async () => {
      git(work, ["checkout", "-q", "main"]);
      writeFileSync(join(work, "feature.txt"), "feature\n");
      const { run } = setup();

      await expect(run("git_commit", { message: "feat: on main" })).rejects.toThrow(
        "commits only on agent/* branches",
      );
      expect(git(work, ["log", "-1", "--format=%s"])).toBe("chore: initial commit");
    });

    it("refuses to commit on a non-agent branch", async () => {
      git(work, ["checkout", "-q", "-b", "feature/x"]);
      writeFileSync(join(work, "feature.txt"), "feature\n");
      const { run } = setup();

      await expect(run("git_commit", { message: "feat" })).rejects.toThrow(
        "commits only on agent/* branches",
      );
    });

    it("refuses an empty message", async () => {
      writeFileSync(join(work, "feature.txt"), "feature\n");
      const { run } = setup();

      await expect(run("git_commit", { message: "   " })).rejects.toThrow("empty");
    });

    it.each([
      ["a parent-relative path", "../x"],
      ["an absolute path", "/etc/passwd"],
      ["a path starting with a dash", "-x"],
      ["a nested parent segment", "src/../../x"],
      ["a pathspec magic", ":(glob)**"],
    ])("refuses %s", async (_label, path) => {
      writeFileSync(join(work, "feature.txt"), "feature\n");
      const { run } = setup();

      await expect(run("git_commit", { message: "feat", paths: [path] })).rejects.toThrow();
      expect(git(work, ["log", "-1", "--format=%s"])).toBe("chore: initial commit");
    });

    it("refuses an empty paths array", async () => {
      writeFileSync(join(work, "feature.txt"), "feature\n");
      const { run } = setup();

      await expect(run("git_commit", { message: "feat", paths: [] })).rejects.toThrow(
        "paths is empty",
      );
    });
  });

  describe("git_push", () => {
    beforeEach(() => {
      writeFileSync(join(work, "feature.txt"), "feature\n");
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", "feat: add feature"]);
    });

    function remoteHasBranch(branch: string): boolean {
      return git(root, ["--git-dir", remote, "branch", "--list", branch]) !== "";
    }

    it("refuses to push when the base branch is unknown", async () => {
      flags = { "cna-auto-push": false };
      const { run } = setup();

      await expect(run("git_push")).rejects.toThrow("base branch unknown; push disabled");
      expect(confirm).not.toHaveBeenCalled();
    });

    it("refuses to push the base branch", async () => {
      git(work, ["checkout", "-q", "main"]);
      const { run } = setup();

      await expect(run("git_push")).rejects.toThrow();
      expect(confirm).not.toHaveBeenCalled();
      expect(remoteHasBranch("main")).toBe(true);
    });

    it("refuses to push a non-agent branch", async () => {
      git(work, ["checkout", "-q", "-b", "feature/x"]);
      const { run } = setup();

      await expect(run("git_push")).rejects.toThrow("agent/*");
      expect(confirm).not.toHaveBeenCalled();
    });

    it("does not push when the user does not confirm", async () => {
      confirm.mockResolvedValue(false);
      const { run } = setup();

      await expect(run("git_push")).rejects.toThrow("Push not confirmed by the user.");
      expect(remoteHasBranch("agent/test")).toBe(false);
    });

    it("pushes the branch when the user confirms", async () => {
      const { run } = setup();

      const result = await run("git_push");

      expect(result.details).toEqual({ branch: "agent/test", confirmed: true, autoPush: false });
      const local = git(work, ["rev-parse", "HEAD"]);
      expect(git(root, ["--git-dir", remote, "rev-parse", "refs/heads/agent/test"])).toBe(local);
    });

    it("asks with a cna:confirm: title that names the branch", async () => {
      const { run } = setup();

      await run("git_push");

      expect(confirm).toHaveBeenCalledTimes(1);
      const [title, message] = confirm.mock.calls[0] ?? [];
      expect(String(title).startsWith("cna:confirm:")).toBe(true);
      expect(String(title)).toContain("agent/test");
      expect(String(message)).toContain("feat: add feature");
    });

    it("does not ask when auto-push is enabled", async () => {
      flags = { "cna-base-branch": "main", "cna-auto-push": true };
      const { run } = setup();

      const result = await run("git_push");

      expect(confirm).not.toHaveBeenCalled();
      expect(result.details).toEqual({ branch: "agent/test", confirmed: true, autoPush: true });
      expect(remoteHasBranch("agent/test")).toBe(true);
    });

    it("never passes force, mirror, delete or extra refspecs to git", async () => {
      writeFileSync(join(work, "more.txt"), "more\n");
      const { run, exec } = setup();

      await run("git_status");
      await run("git_commit", { message: "feat: more" });
      await run("git_push");

      const forbidden = [
        "--force",
        "-f",
        "--force-with-lease",
        "--mirror",
        "--all",
        "--tags",
        "--delete",
      ];
      expect(exec.mock.calls.length).toBeGreaterThan(0);
      for (const [command, args] of exec.mock.calls) {
        expect(command).toBe("git");
        for (const arg of args) {
          expect(arg.startsWith("--force")).toBe(false);
          expect(forbidden).not.toContain(arg);
        }
      }
    });
  });

  describe("create_pr", () => {
    const pr = { title: "Add feature", body: "Body text" };
    const expectedArgs = [
      "pr",
      "create",
      "--base=main",
      "--head=agent/test",
      "--title=Add feature",
      "--body=Body text",
    ];

    beforeEach(() => {
      writeFileSync(join(work, "feature.txt"), "feature\n");
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", "feat: add feature"]);
    });

    /** Publishes the agent branch to origin under the same name, as git_push does. */
    function pushBranch(): void {
      git(work, ["push", "-q", "origin", "HEAD:refs/heads/agent/test"]);
    }

    function ghCalls(exec: ReturnType<typeof vi.fn>): unknown[][] {
      return exec.mock.calls.filter(([command]) => command === "gh");
    }

    it("names create_pr in its prompt guideline", () => {
      const { registered } = setup();
      const tool = registered().find((t) => t.name === "create_pr");
      expect(tool?.promptGuidelines).toEqual([
        "Use create_pr after git_push to open a pull request; never run gh pr create in bash.",
      ]);
    });

    it("refuses when the base branch is unknown and never calls gh", async () => {
      flags = { "cna-auto-push": false };
      pushBranch();
      const { run, exec } = setup();

      await expect(run("create_pr", pr)).rejects.toThrow(
        "base branch unknown; pull requests disabled",
      );
      expect(ghCalls(exec)).toHaveLength(0);
    });

    it.each([
      ["an empty title", "   ", "empty"],
      ["a title of 257 characters", "a".repeat(257), "longer than 256"],
    ])("refuses %s", async (_label, title, message) => {
      pushBranch();
      const { run, exec } = setup();

      await expect(run("create_pr", { ...pr, title })).rejects.toThrow(message);
      expect(ghCalls(exec)).toHaveLength(0);
    });

    it("refuses a body longer than 65536 characters", async () => {
      pushBranch();
      const { run, exec } = setup();

      await expect(run("create_pr", { ...pr, body: "x".repeat(65_537) })).rejects.toThrow(
        "longer than 65536",
      );
      expect(ghCalls(exec)).toHaveLength(0);
    });

    it("refuses a branch that is not agent/*", async () => {
      git(work, ["checkout", "-q", "-b", "feature/x"]);
      const { run, exec } = setup();

      await expect(run("create_pr", pr)).rejects.toThrow("pull requests only from agent/*");
      expect(ghCalls(exec)).toHaveLength(0);
    });

    it("refuses the base branch itself", async () => {
      flags = { "cna-base-branch": "agent/test", "cna-auto-push": false };
      pushBranch();
      const { run, exec } = setup();

      await expect(run("create_pr", pr)).rejects.toThrow("pull requests only from agent/*");
      expect(ghCalls(exec)).toHaveLength(0);
    });

    it("refuses a branch that is not on origin and never calls gh", async () => {
      const { run, exec } = setup();

      await expect(run("create_pr", pr)).rejects.toThrow("use git_push first");
      expect(ghCalls(exec)).toHaveLength(0);
      expect(confirm).not.toHaveBeenCalled();
    });

    it("refuses a branch with commits that are not pushed and never calls gh", async () => {
      pushBranch();
      writeFileSync(join(work, "more.txt"), "more\n");
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", "feat: more"]);
      const { run, exec } = setup();

      await expect(run("create_pr", pr)).rejects.toThrow("not pushed");
      expect(ghCalls(exec)).toHaveLength(0);
    });

    it("does not create the pull request when the user does not confirm", async () => {
      confirm.mockResolvedValue(false);
      pushBranch();
      const { run, exec } = setup();

      await expect(run("create_pr", pr)).rejects.toThrow("Pull request not confirmed by the user.");
      expect(ghCalls(exec)).toHaveLength(0);
    });

    it("asks with a cna:confirm: title that names the branch and base", async () => {
      pushBranch();
      const { run } = setup();

      await expect(run("create_pr", pr)).resolves.toBeDefined();

      expect(confirm).toHaveBeenCalledTimes(1);
      const [title, message] = confirm.mock.calls[0] ?? [];
      expect(String(title).startsWith("cna:confirm:")).toBe(true);
      expect(String(title)).toContain("agent/test");
      expect(String(title)).toContain("main");
      expect(String(message)).toContain("Add feature");
    });

    it("runs gh with the exact arguments and the repository as cwd once confirmed", async () => {
      pushBranch();
      const { run, exec } = setup();

      const result = await run("create_pr", pr);

      expect(ghCalls(exec)).toEqual([
        ["gh", expectedArgs, expect.objectContaining({ cwd: work, timeout: 120_000 })],
      ]);
      expect(result.content[0]?.text).toBe(
        "Created pull request https://github.com/owner/repo/pull/7",
      );
      expect(result.details).toEqual({
        url: "https://github.com/owner/repo/pull/7",
        base: "main",
        branch: "agent/test",
        draft: false,
      });
    });

    it("skips confirmation with auto-push and adds --draft last for drafts", async () => {
      flags = { "cna-base-branch": "main", "cna-auto-push": true };
      pushBranch();
      const { run, exec } = setup();

      const result = await run("create_pr", { ...pr, draft: true });

      expect(confirm).not.toHaveBeenCalled();
      const [call] = ghCalls(exec);
      expect(call?.[1]).toEqual([...expectedArgs, "--draft"]);
      expect(result.details).toEqual({
        url: "https://github.com/owner/repo/pull/7",
        base: "main",
        branch: "agent/test",
        draft: true,
      });
    });

    it("fails with gh's stderr when gh exits with an error", async () => {
      pushBranch();
      const { run } = setup(() => ({
        stdout: "",
        stderr: "GraphQL: a pull request already exists\n",
        code: 1,
        killed: false,
        truncated: false,
      }));

      await expect(run("create_pr", pr)).rejects.toThrow(
        "gh pr create failed (exit 1): GraphQL: a pull request already exists",
      );
    });

    it("fails when gh prints no pull request URL", async () => {
      pushBranch();
      const { run } = setup(() => ({
        stdout: "Done.\n",
        stderr: "",
        code: 0,
        killed: false,
        truncated: false,
      }));

      await expect(run("create_pr", pr)).rejects.toThrow(
        "gh pr create did not print the pull request URL",
      );
    });
  });
});
