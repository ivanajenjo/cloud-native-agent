import { type ExecFileException, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface GitResult {
  stdout: string;
  stderr: string;
}

const STDERR_LIMIT = 2000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_BRANCH_NUMBER = 100;
const SLUG_MAX_WORDS = 6;
const SLUG_MAX_LENGTH = 40;

/** Error from a failed git command. Its args never include env values. */
export class GitError extends Error {
  /** git subcommand and args, e.g. "clone". Never includes env values. */
  readonly args: string[];
  readonly exitCode: number | null;
  /** stderr, truncated to 2000 chars. */
  readonly stderr: string;

  constructor(message: string, init: { args: string[]; exitCode: number | null; stderr: string }) {
    super(message);
    this.name = "GitError";
    this.args = [...init.args];
    this.exitCode = init.exitCode;
    this.stderr = init.stderr;
  }
}

/** Runs git with the given args in cwd. */
export type GitRunner = (args: string[], options: { cwd: string }) => Promise<GitResult>;

/**
 * Final environment for a git child process: undefined values are dropped and
 * GIT_TERMINAL_PROMPT=0 is always set, so git never waits for a terminal prompt.
 */
export function gitEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  result.GIT_TERMINAL_PROMPT = "0";
  return result;
}

/**
 * execFile("git", args, { cwd, env, maxBuffer: 16 MiB }) with GIT_TERMINAL_PROMPT=0 added to env;
 * rejects GitError. No shell.
 */
export function createGitRunner(env: Record<string, string | undefined>): GitRunner {
  const childEnv = gitEnv(env);
  return (args, options) =>
    new Promise<GitResult>((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: options.cwd, env: childEnv, maxBuffer: MAX_BUFFER, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) {
            reject(toGitError(args, error, stderr));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
}

function toGitError(args: string[], error: ExecFileException, stderr: string): GitError {
  const exitCode = typeof error.code === "number" ? error.code : null;
  const truncated = (stderr ?? "").slice(0, STDERR_LIMIT);
  const firstLine = truncated.split("\n")[0]?.trim() ?? "";
  const reason =
    exitCode !== null ? `exit code ${exitCode}` : String(error.code ?? "unknown error");
  const message = `git ${args[0] ?? ""} failed (${reason})${firstLine ? `: ${firstLine}` : ""}`;
  return new GitError(message, { args, exitCode, stderr: truncated });
}

/**
 * Slug for the branch name from the prompt: NFKD, strip diacritics, lowercase, non [a-z0-9] runs → "-",
 * trim "-", first 6 words max, max 40 chars (cut at a "-" boundary if possible, never ending in "-").
 * Empty result → "task".
 */
export function slugify(prompt: string): string {
  const ascii = prompt
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const words = ascii.split("-").filter((word) => word !== "");
  let slug = words.slice(0, SLUG_MAX_WORDS).join("-");

  if (slug.length > SLUG_MAX_LENGTH) {
    // A cut right before a "-" is already a word boundary.
    if (slug[SLUG_MAX_LENGTH] !== "-") {
      const head = slug.slice(0, SLUG_MAX_LENGTH);
      const lastDash = head.lastIndexOf("-");
      slug = lastDash > 0 ? head.slice(0, lastDash) : head;
    } else {
      slug = slug.slice(0, SLUG_MAX_LENGTH);
    }
    slug = slug.replace(/-+$/, "");
  }

  return slug === "" ? "task" : slug;
}

/** The credential helper written in the clone's config so git asks gh for the token (GITHUB_TOKEN/GH_TOKEN env). */
export const GH_CREDENTIAL_HELPER = "!gh auth git-credential";

const DEFAULT_REMOTE_BASE = "https://github.com/";

export interface PrepareWorkspaceOptions {
  git: GitRunner;
  /** "owner/name" (already validated). */
  repo: string;
  /** Requested base branch; default: the remote's default branch. */
  baseBranch?: string;
  /** Target directory (absolute). Must NOT exist or be empty. */
  dir: string;
  slug: string;
  userName?: string;
  userEmail?: string;
  /** Default "https://github.com/". Tests pass a "file:///..." base. The URL is `${remoteBase}${repo}.git`. */
  remoteBase?: string;
}

export interface PreparedWorkspace {
  baseBranch: string;
  branch: string;
}

/**
 * Clones the repo into dir, picks the base branch and creates the work branch agent/<slug>
 * (with a numeric suffix if it already exists on the remote), and sets the commit identity.
 */
export async function prepareWorkspace(
  options: PrepareWorkspaceOptions,
): Promise<PreparedWorkspace> {
  const { git, repo, dir, slug, userName, userEmail } = options;
  const remoteBase = options.remoteBase ?? DEFAULT_REMOTE_BASE;
  const parent = dirname(dir);

  // Validated before touching the disk: check-ref-format runs in an existing ancestor.
  if (options.baseBranch !== undefined) {
    const valid = await isValidBranchName(
      git,
      options.baseBranch,
      await nearestExistingDir(parent),
    );
    if (!valid) {
      throw new Error(`invalid base branch "${options.baseBranch}"`);
    }
  }

  await assertEmptyOrMissing(dir);
  await mkdir(parent, { recursive: true });

  // Credentials never go in the URL. The first empty helper resets inherited helpers.
  const cloneArgs = [
    "clone",
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${GH_CREDENTIAL_HELPER}`,
  ];
  if (options.baseBranch !== undefined) {
    cloneArgs.push("--branch", options.baseBranch);
  }
  cloneArgs.push("--", `${remoteBase}${repo}.git`, dir);
  await git(cloneArgs, { cwd: parent });

  const baseBranch = options.baseBranch ?? (await readRemoteDefaultBranch(git, dir));
  const branch = await pickBranchName(git, dir, slug);

  await git(["checkout", "-b", branch], { cwd: dir });

  if (userName !== undefined) {
    await git(["config", "user.name", userName], { cwd: dir });
  }
  if (userEmail !== undefined) {
    await git(["config", "user.email", userEmail], { cwd: dir });
  }

  return { baseBranch, branch };
}

/** True if `git check-ref-format --branch` accepts the name and it does not start with "-". */
async function isValidBranchName(git: GitRunner, name: string, cwd: string): Promise<boolean> {
  if (name.startsWith("-")) {
    return false;
  }
  try {
    await git(["check-ref-format", "--branch", name], { cwd });
    return true;
  } catch (error) {
    if (error instanceof GitError) {
      return false;
    }
    throw error;
  }
}

async function assertEmptyOrMissing(dir: string): Promise<void> {
  let isEmpty: boolean;
  try {
    const info = await stat(dir);
    isEmpty = info.isDirectory() && (await readdir(dir)).length === 0;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!isEmpty) {
    throw new Error("workspace not empty");
  }
}

async function nearestExistingDir(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) {
        return current;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

async function readRemoteDefaultBranch(git: GitRunner, dir: string): Promise<string> {
  const { stdout } = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd: dir,
  });
  const name = stdout.trim().replace(/^origin\//, "");
  if (name === "") {
    throw new Error("could not determine the remote default branch");
  }
  return name;
}

async function pickBranchName(git: GitRunner, dir: string, slug: string): Promise<string> {
  for (let n = 1; n <= MAX_BRANCH_NUMBER; n++) {
    const name = n === 1 ? `agent/${slug}` : `agent/${slug}-${n}`;
    if (!(await isValidBranchName(git, name, dir))) {
      throw new Error(`invalid branch name "${name}"`);
    }
    const { stdout } = await git(["ls-remote", "--heads", "origin", `refs/heads/${name}`], {
      cwd: dir,
    });
    if (stdout.trim() === "") {
      return name;
    }
  }
  throw new Error(`no free branch name for agent/${slug} (tried up to -${MAX_BRANCH_NUMBER})`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** "clean", or why the workspace cannot be discarded. Never throws for a dirty tree. */
export async function workspaceState(
  git: GitRunner,
  dir: string,
  options: { checkUnpushed: boolean },
): Promise<"clean" | "uncommitted" | "unpushed"> {
  if (!existsSync(join(dir, ".git"))) {
    return "clean";
  }
  const status = await git(["status", "--porcelain"], { cwd: dir });
  if (status.stdout.trim() !== "") {
    return "uncommitted";
  }
  if (options.checkUnpushed) {
    // Commits that no remote-tracking branch of origin contains (covers a missing remote branch).
    const unpushed = await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"], {
      cwd: dir,
    });
    if (Number.parseInt(unpushed.stdout.trim(), 10) > 0) {
      return "unpushed";
    }
  }
  return "clean";
}
