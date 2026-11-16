/**
 * Extension `git`: `git_status`, `git_commit` and `git_push`. The agent commits only on
 * `agent/*` branches and never pushes the base branch. Git runs through `pi.exec` without
 * a shell. Pushes need the user's confirmation unless `cna-auto-push` is set.
 */

import { posix, win32 } from "node:path";
import { encodeQuestionTitle } from "@cna/shared";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BRANCH_PREFIX = "agent/";
const BASE_BRANCH_FLAG = "cna-base-branch";
const AUTO_PUSH_FLAG = "cna-auto-push";
const GIT_TIMEOUT_MS = 120_000;
const MAX_STDERR_CHARS = 2000;

/** Runs git without a shell. A non-zero exit code is returned, not thrown. */
function git(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
  args: string[],
): Promise<ExecResult> {
  return pi.exec("git", args, { signal, cwd, timeout: GIT_TIMEOUT_MS });
}

/** Error for a git command that failed, with stderr bounded so output stays small. */
function gitFailure(args: string[], result: ExecResult): Error {
  const stderr = result.stderr.trim().slice(0, MAX_STDERR_CHARS);
  return new Error(`git ${args[0] ?? ""} failed (exit ${result.code}): ${stderr}`);
}

/** Runs git and returns its stdout. A non-zero exit code becomes an error. */
async function gitOk(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
  args: string[],
): Promise<string> {
  const result = await git(pi, cwd, signal, args);
  if (result.code !== 0) {
    throw gitFailure(args, result);
  }
  return result.stdout;
}

async function currentBranch(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const output = await gitOk(pi, cwd, signal, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return output.trim();
}

/** The session's base branch, or undefined when the flag is missing or empty. */
function baseBranch(pi: ExtensionAPI): string | undefined {
  const value = pi.getFlag(BASE_BRANCH_FLAG);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isAgentBranch(branch: string, base: string | undefined): boolean {
  return branch.startsWith(BRANCH_PREFIX) && branch !== base;
}

/** Rejects paths that could leave the repository or be read as git options. */
function assertSafePaths(paths: string[]): void {
  if (paths.length === 0) {
    throw new Error("paths is empty; omit it to stage all changes.");
  }
  for (const path of paths) {
    if (path.trim() === "") {
      throw new Error("Paths must not be empty.");
    }
    if (posix.isAbsolute(path) || win32.isAbsolute(path)) {
      throw new Error(`Absolute paths are not allowed: ${path}`);
    }
    if (path.split(/[\\/]/).includes("..")) {
      throw new Error(`Paths outside the repository are not allowed: ${path}`);
    }
    if (path.startsWith("-")) {
      throw new Error(`Paths must not start with "-": ${path}`);
    }
    // Pathspec magic such as ":(glob)**" would stage more than the paths asked for.
    if (path.startsWith(":")) {
      throw new Error(`Pathspec magic is not allowed: ${path}`);
    }
  }
}

/** Branch name from the `## ...` header of `git status --porcelain=v1 --branch`. */
function parseStatusBranch(header: string): string {
  const body = header.startsWith("## ") ? header.slice(3) : header;
  const noCommitsPrefix = "No commits yet on ";
  if (body.startsWith(noCommitsPrefix)) {
    return body.slice(noCommitsPrefix.length);
  }
  if (body.startsWith("HEAD (no branch)")) {
    return "HEAD";
  }
  return body.split(/\.\.\.| /)[0] ?? "";
}

const statusParameters = Type.Object({});

const commitParameters = Type.Object({
  message: Type.String({ description: "Commit message. Required and not empty." }),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Files to stage, relative to the repository root. Omit to stage all changes.",
    }),
  ),
});

const pushParameters = Type.Object({});

export default function gitExtension(pi: ExtensionAPI): void {
  pi.registerFlag(BASE_BRANCH_FLAG, {
    description: "Base branch of the session. git_push refuses to push it.",
    type: "string",
  });
  pi.registerFlag(AUTO_PUSH_FLAG, {
    description: "Push without asking the user for confirmation.",
    type: "boolean",
    default: false,
  });

  pi.registerTool({
    name: "git_status",
    label: "Git status",
    description: "Show the current branch and the working tree status of the repository.",
    promptGuidelines: [
      "Use git_status to check the branch and the changed files before using git_commit.",
    ],
    parameters: statusParameters,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const output = await gitOk(pi, ctx.cwd, signal, ["status", "--porcelain=v1", "--branch"]);
      const lines = output.split("\n").filter((line) => line.length > 0);
      const header = lines.shift() ?? "";
      const branch = parseStatusBranch(header);
      const clean = lines.length === 0;
      const text = clean ? `${header}\nWorking tree clean.` : output.trimEnd();
      return { content: [{ type: "text", text }], details: { branch, clean } };
    },
  });

  pi.registerTool({
    name: "git_commit",
    label: "Git commit",
    description:
      "Stage the given paths (or all changes) and commit them on the current agent/* branch. " +
      "Fails if there is nothing to commit or the branch is not an agent branch.",
    promptGuidelines: [
      "Use git_commit to commit your changes instead of running git commit in bash.",
    ],
    parameters: commitParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const message = params.message.trim();
      if (message === "") {
        throw new Error("The commit message is empty.");
      }
      const cwd = ctx.cwd;
      const branch = await currentBranch(pi, cwd, signal);
      if (!isAgentBranch(branch, baseBranch(pi))) {
        throw new Error(`commits only on agent/* branches (current branch: ${branch})`);
      }

      // This tool changes the git index, not files in the working tree, so it does not
      // need withFileMutationQueue().
      if (params.paths !== undefined) {
        assertSafePaths(params.paths);
        await gitOk(pi, cwd, signal, ["add", "--", ...params.paths]);
      } else {
        await gitOk(pi, cwd, signal, ["add", "-A"]);
      }

      // --quiet makes git exit 0 when nothing is staged and 1 when something is.
      const staged = await git(pi, cwd, signal, ["diff", "--cached", "--quiet"]);
      if (staged.code === 0) {
        throw new Error("Nothing to commit.");
      }
      if (staged.code !== 1) {
        throw gitFailure(["diff", "--cached", "--quiet"], staged);
      }

      await gitOk(pi, cwd, signal, ["commit", "-m", message]);
      const commit = (await gitOk(pi, cwd, signal, ["rev-parse", "--short", "HEAD"])).trim();
      return {
        content: [{ type: "text", text: `Committed ${commit} on ${branch}.` }],
        details: { branch, commit },
      };
    },
  });

  pi.registerTool({
    name: "git_push",
    label: "Git push",
    description:
      "Push the current agent/* branch to origin. Asks the user for confirmation first, " +
      "unless the session has auto-push enabled. Never pushes the base branch.",
    promptGuidelines: ["Use git_push to publish the branch; never push with bash."],
    parameters: pushParameters,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const base = baseBranch(pi);
      if (base === undefined) {
        throw new Error("base branch unknown; push disabled");
      }
      const cwd = ctx.cwd;
      const branch = await currentBranch(pi, cwd, signal);
      if (!isAgentBranch(branch, base)) {
        throw new Error(
          `push only from agent/* branches other than the base (current branch: ${branch})`,
        );
      }

      const autoPush = pi.getFlag(AUTO_PUSH_FLAG) === true;
      if (!autoPush) {
        const lastCommit = (await gitOk(pi, cwd, signal, ["log", "-1", "--oneline"])).trim();
        const confirmed = await ctx.ui.confirm(
          encodeQuestionTitle("confirm", `Push ${branch} to origin?`),
          `Branch: ${branch}\nLast commit: ${lastCommit}`,
        );
        if (!confirmed) {
          throw new Error("Push not confirmed by the user.");
        }
      }

      // Only the current agent branch, to the branch with the same name. Never force,
      // never mirror, never delete.
      await gitOk(pi, cwd, signal, [
        "push",
        "--set-upstream",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
      // Reaching this point means the user confirmed or auto-push is on.
      return {
        content: [{ type: "text", text: `Pushed ${branch} to origin.` }],
        details: { branch, confirmed: true, autoPush },
      };
    },
  });
}
