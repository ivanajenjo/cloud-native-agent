/**
 * Extension `guard`: blocks obviously dangerous commands in the `bash` tool. It is a guard
 * against the model's slips, not a security boundary: deliberate obfuscation is out of scope.
 * The security boundary is the container network policy (ADR-0004) and the edge (ADR-0006).
 */

import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

/** Maximum nesting of `sh -c` and `eval` that is analyzed. Deeper levels are blocked. */
const MAX_DEPTH = 5;

const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas"]);
const PRIVILEGE_REASON = "Privilege escalation is not available in this environment.";

const CONTAINER_COMMANDS = new Set(["docker", "podman", "nerdctl", "kubectl", "ctr"]);
const CONTAINER_REASON = "Containers are not available in this environment: there is no Docker.";

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash"]);
const DOWNLOAD_COMMANDS = new Set(["curl", "wget"]);
const PIPE_TO_SHELL_REASON = "Piping downloads into a shell is not allowed.";

const WRAPPER_COMMANDS = new Set(["env", "nohup", "time", "exec", "command", "nice"]);

const GIT_PUSH_REASON = "Use the git_push tool instead of git push in bash.";
const GIT_FORCE_REASON = "Force operations are not allowed.";
const GIT_REMOTE_REASON = "Changing git remotes is not allowed.";
const GIT_CONFIG_REASON = "Changing global git configuration or credentials is not allowed.";
const GIT_REMOTE_CHANGES = new Set(["add", "set-url", "rename", "remove", "rm"]);

const GH_CREATE_PR_REASON = "Use the create_pr tool instead of gh pr create.";
const GH_NOT_ALLOWED_REASON = "This gh operation is not allowed.";
const GH_BLOCKED_GROUPS = new Set(["release", "secret", "auth"]);
const GH_BLOCKED_PR_ACTIONS = new Set(["merge", "close"]);
const GH_BLOCKED_REPO_ACTIONS = new Set(["delete", "create", "edit", "fork"]);

const RM_REASON = "Refusing to delete this path recursively.";
// "${HOME}" is spelled out so biome does not read it as a template placeholder.
const BRACED_HOME = ["$", "{HOME}"].join("");
const DANGEROUS_RM_TARGETS = new Set([
  "/",
  "/*",
  "~",
  "~/",
  "~/*",
  "$HOME",
  "$HOME/",
  "$HOME/*",
  ".",
  "./",
  "..",
  "../",
  "../*",
  "*",
  BRACED_HOME,
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One simple command: its words, and the operator that follows it ("" at the end). */
interface Segment {
  tokens: string[];
  separator: string;
}

/**
 * Splits a command into words and segments. Quotes group characters (single: literal;
 * double: `\` escapes the next character). Separators count only outside quotes.
 */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;

  const endToken = (): void => {
    if (inToken) {
      tokens.push(token);
      token = "";
      inToken = false;
    }
  };
  const endSegment = (separator: string): void => {
    endToken();
    segments.push({ tokens, separator });
    tokens = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);

    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const stop = close === -1 ? command.length : close;
      token += command.slice(i + 1, stop);
      inToken = true;
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      inToken = true;
      i++;
      while (i < command.length && command.charAt(i) !== '"') {
        if (command.charAt(i) === "\\" && i + 1 < command.length) {
          token += command.charAt(i + 1);
          i += 2;
        } else {
          token += command.charAt(i);
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === "\\") {
      if (next === "\n") {
        // Line continuation: removed entirely.
        i += 2;
        continue;
      }
      if (i + 1 < command.length) {
        token += next;
        inToken = true;
      }
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endToken();
      i++;
      continue;
    }
    if (ch === "\n") {
      endSegment("\n");
      i++;
      continue;
    }
    if (ch === ";") {
      endSegment(";");
      i++;
      continue;
    }
    if (ch === "&") {
      const previous = command.charAt(i - 1);
      // `2>&1` and `&>file` are redirections, not separators.
      if (previous === ">" || previous === "<" || next === ">") {
        token += ch;
        inToken = true;
        i++;
        continue;
      }
      if (next === "&") {
        endSegment("&&");
        i += 2;
        continue;
      }
      endSegment("&");
      i++;
      continue;
    }
    if (ch === "|") {
      if (next === "|") {
        endSegment("||");
        i += 2;
        continue;
      }
      if (next === "&") {
        endSegment("|&");
        i += 2;
        continue;
      }
      endSegment("|");
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "`") {
      endSegment(ch);
      i++;
      continue;
    }
    if (ch === "$" && next === "(") {
      endSegment("$(");
      i += 2;
      continue;
    }

    token += ch;
    inToken = true;
    i++;
  }
  endSegment("");
  return segments;
}

function baseName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * Index of the command word: skips assignments and wrapper words (and the options that
 * follow a wrapper). Returns tokens.length when there is no command word.
 */
function commandStart(tokens: string[]): number {
  let i = 0;
  let wrapper: string | undefined;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (ASSIGNMENT.test(token)) {
      i++;
    } else if (WRAPPER_COMMANDS.has(baseName(token))) {
      wrapper = baseName(token);
      i++;
    } else if (wrapper !== undefined && token.startsWith("-") && token !== "-") {
      // `nice -n 10 cmd` takes a value after -n.
      i += wrapper === "nice" && token === "-n" ? 2 : 1;
    } else {
      return i;
    }
  }
  return tokens.length;
}

/** Lowercased base name of the command word, or undefined if the segment has none. */
function commandNameOf(tokens: string[]): string | undefined {
  const start = commandStart(tokens);
  return start < tokens.length ? baseName(tokens[start] ?? "") : undefined;
}

function checkGit(args: string[]): string | null {
  let i = 0;
  while (i < args.length) {
    const token = args[i] ?? "";
    if (token === "-C" || token === "-c") {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const subcommand = (args[i] ?? "").toLowerCase();
  const subArgs = args.slice(i + 1);

  if (subcommand === "push") {
    return GIT_PUSH_REASON;
  }
  const forced = args.some(
    (token) =>
      token === "--force" ||
      token.startsWith("--force-with-lease") ||
      token.startsWith("--force-if-includes"),
  );
  if (forced) {
    return GIT_FORCE_REASON;
  }
  if (subcommand === "remote") {
    const action = (subArgs.find((token) => !token.startsWith("-")) ?? "").toLowerCase();
    if (GIT_REMOTE_CHANGES.has(action)) {
      return GIT_REMOTE_REASON;
    }
  }
  if (subcommand === "config") {
    const global = subArgs.some((token) => token === "--global" || token === "--system");
    const credential = subArgs.some((token) => token.toLowerCase().includes("credential"));
    if (global || credential) {
      return GIT_CONFIG_REASON;
    }
  }
  return null;
}

function checkGh(args: string[]): string | null {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "-R" || token === "--repo") {
      i++;
      continue;
    }
    if (!token.startsWith("-")) {
      words.push(token.toLowerCase());
    }
  }
  const group = words[0];
  const action = words[1];
  if (group === "pr" && action === "create") {
    return GH_CREATE_PR_REASON;
  }
  if (group === undefined) {
    return null;
  }
  if (
    GH_BLOCKED_GROUPS.has(group) ||
    (group === "pr" && action !== undefined && GH_BLOCKED_PR_ACTIONS.has(action)) ||
    (group === "repo" && action !== undefined && GH_BLOCKED_REPO_ACTIONS.has(action))
  ) {
    return GH_NOT_ALLOWED_REASON;
  }
  return null;
}

/** Targets that would wipe the home, the repository root, the system or a top-level dir. */
function isDangerousRmTarget(target: string): boolean {
  if (DANGEROUS_RM_TARGETS.has(target)) {
    return true;
  }
  if (target.startsWith("/")) {
    const parts = target
      .replace(/\/+$/, "")
      .split("/")
      .filter((part) => part !== "");
    // `/usr`, `/etc/`, `/data`, and `/home/*`.
    return parts.length === 1 || (parts.length === 2 && parts[1] === "*");
  }
  return false;
}

function checkRm(args: string[]): string | null {
  const recursive = args.some(
    (token) =>
      token === "--recursive" || (token.startsWith("-") && token !== "--" && /[rR]/.test(token)),
  );
  if (!recursive) {
    return null;
  }
  const targets = args.filter((token) => !token.startsWith("-"));
  return targets.some(isDangerousRmTarget) ? RM_REASON : null;
}

/** Reason for a single simple command, or null. Runs nested `sh -c` and `eval` too. */
function checkCommand(tokens: string[], depth: number): string | null {
  const start = commandStart(tokens);
  if (start >= tokens.length) {
    return null;
  }
  const name = baseName(tokens[start] ?? "");
  const args = tokens.slice(start + 1);

  if (PRIVILEGE_COMMANDS.has(name)) {
    return PRIVILEGE_REASON;
  }
  if (CONTAINER_COMMANDS.has(name)) {
    return CONTAINER_REASON;
  }
  if (SHELL_COMMANDS.has(name)) {
    const flag = args.indexOf("-c");
    const script = flag === -1 ? undefined : args[flag + 1];
    return script === undefined ? null : analyze(script, depth + 1);
  }
  if (name === "eval") {
    return analyze(args.join(" "), depth + 1);
  }
  if (name === "git") {
    return checkGit(args);
  }
  if (name === "gh") {
    return checkGh(args);
  }
  if (name === "rm") {
    return checkRm(args);
  }
  return null;
}

/** A download piped straight into a shell, as in `curl ... | sh`. */
function isPipeToShell(segments: Segment[], index: number): boolean {
  const segment = segments[index];
  const following = segments[index + 1];
  if (segment === undefined || following === undefined) {
    return false;
  }
  if (segment.separator !== "|" && segment.separator !== "|&") {
    return false;
  }
  const download = commandNameOf(segment.tokens);
  const shell = commandNameOf(following.tokens);
  return (
    download !== undefined &&
    DOWNLOAD_COMMANDS.has(download) &&
    shell !== undefined &&
    SHELL_COMMANDS.has(shell)
  );
}

function analyze(command: string, depth: number): string | null {
  if (depth > MAX_DEPTH) {
    return "Command nesting is too deep to check.";
  }
  const segments = splitSegments(command);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) {
      continue;
    }
    const reason = checkCommand(segment.tokens, depth);
    if (reason !== null) {
      return reason;
    }
    if (isPipeToShell(segments, i)) {
      return PIPE_TO_SHELL_REASON;
    }
  }
  return null;
}

/** Why the command is blocked, or null if it is allowed. Pure. */
export function checkBashCommand(command: string): string | null {
  return analyze(command, 0);
}

export default function guardExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) {
      return undefined;
    }
    const reason = checkBashCommand(event.input.command);
    if (reason === null) {
      return undefined;
    }
    return { block: true, reason };
  });
}
