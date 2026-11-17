import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { z } from "zod";
import {
  cloneRepo,
  GitError,
  type GitRunner,
  isValidBranchName,
  nearestExistingDir,
  type PreparedWorkspace,
} from "./git.js";

/** Runs gh with args in cwd. */
export type GhRunner = (
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

const MAX_BUFFER = 16 * 1024 * 1024;
const GH_MESSAGE_LIMIT = 300;

/**
 * execFile("gh", args, { cwd, env, maxBuffer: 16 MiB }) with env = base env (undefined dropped) + GH_PROMPT_DISABLED=1,
 * NO_COLOR=1, GH_NO_UPDATE_NOTIFIER=1. No shell. Rejects Error(`gh <args[0]> failed: <first line of stderr, max 300 chars>`):
 * never includes env values.
 */
export function createGhRunner(env: Record<string, string | undefined>): GhRunner {
  const childEnv: Record<string, string> = {
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !(key in childEnv)) {
      childEnv[key] = value;
    }
  }

  return (args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        "gh",
        args,
        { cwd: options.cwd, env: childEnv, maxBuffer: MAX_BUFFER, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) {
            const firstLine = (stderr ?? "").split("\n")[0]?.trim() ?? "";
            const reason =
              firstLine.slice(0, GH_MESSAGE_LIMIT) ||
              `exit code ${String(error.code ?? "unknown")}`;
            reject(new Error(`gh ${args[0] ?? ""} failed: ${reason}`));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
}

export interface PullRequestInfo {
  number: number;
  headBranch: string;
  baseBranch: string;
}

/** The PR cannot be used by the agent; the message is safe to show to the user. */
export class PullRequestError extends Error {}

const PrViewSchema = z.object({
  number: z.number(),
  state: z.string(),
  isCrossRepository: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
});

/**
 * `gh pr view <number> --repo <repo> --json number,state,isCrossRepository,headRefName,baseRefName`, run in `cwd`.
 * Throws PullRequestError when: gh fails, the output is not that JSON, the PR is not OPEN, comes from a fork,
 * its head branch is not agent/*, or its head is the base branch.
 */
export async function resolvePullRequest(
  gh: GhRunner,
  repo: string,
  number: number,
  cwd: string,
): Promise<PullRequestInfo> {
  let stdout: string;
  try {
    ({ stdout } = await gh(
      [
        "pr",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        "number,state,isCrossRepository,headRefName,baseRefName",
      ],
      { cwd },
    ));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PullRequestError(`pull request #${number} not found or not accessible: ${reason}`);
  }

  const unexpected = new PullRequestError(
    `pull request #${number} returned unexpected data from gh`,
  );
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw unexpected;
  }
  const parsed = PrViewSchema.safeParse(json);
  if (!parsed.success) {
    throw unexpected;
  }
  const pr = parsed.data;

  if (pr.state !== "OPEN") {
    throw new PullRequestError(`pull request #${number} is ${pr.state.toLowerCase()}`);
  }
  if (pr.isCrossRepository) {
    throw new PullRequestError(`pull request #${number} comes from a fork`);
  }
  if (!pr.headRefName.startsWith("agent/")) {
    throw new PullRequestError(`pull request #${number} is not from an agent/* branch`);
  }
  if (pr.headRefName === pr.baseRefName) {
    throw new PullRequestError(
      `pull request #${number} has the same head and base branch "${pr.headRefName}"`,
    );
  }

  return {
    number: pr.number,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
  };
}

export interface PreparePrOptions {
  git: GitRunner;
  /** "owner/name" (already validated). */
  repo: string;
  /** Target directory (absolute). Must NOT exist or be empty. */
  dir: string;
  pr: PullRequestInfo;
  userName?: string;
  userEmail?: string;
  /** Default "https://github.com/". */
  remoteBase?: string;
}

/**
 * Clones the repo on the PR head branch (`cloneRepo` with branch = pr.headBranch) and checks that origin/<baseBranch>
 * exists (fetch it with `git fetch origin <base>:refs/remotes/origin/<base>` if the clone did not bring it).
 * Validates both branch names with `git check-ref-format --branch` and that they do not start with "-" BEFORE cloning.
 * Returns { baseBranch: pr.baseBranch, branch: pr.headBranch }.
 */
export async function preparePrWorkspace(options: PreparePrOptions): Promise<PreparedWorkspace> {
  const { git, repo, dir, pr, userName, userEmail, remoteBase } = options;

  // Validated before touching the disk: check-ref-format runs in an existing ancestor.
  const validationCwd = await nearestExistingDir(dirname(dir));
  for (const name of [pr.headBranch, pr.baseBranch]) {
    if (!(await isValidBranchName(git, name, validationCwd))) {
      throw new Error(`invalid branch name "${name}"`);
    }
  }

  await cloneRepo({ git, repo, dir, branch: pr.headBranch, userName, userEmail, remoteBase });

  const baseRef = `refs/remotes/origin/${pr.baseBranch}`;
  if (!(await refExists(git, dir, baseRef))) {
    await git(["fetch", "origin", `${pr.baseBranch}:${baseRef}`], { cwd: dir });
  }

  return { baseBranch: pr.baseBranch, branch: pr.headBranch };
}

async function refExists(git: GitRunner, dir: string, ref: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", ref], { cwd: dir });
    return true;
  } catch (error) {
    if (error instanceof GitError) {
      return false;
    }
    throw error;
  }
}
