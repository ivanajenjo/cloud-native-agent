/**
 * Parser of the unified diff (`git diff`) returned in `DiffResponse.patch` (feature 3). The web
 * diff view paints every line by its kind. Pure functions: no DOM, no I/O, and they never throw.
 *
 * The patch may be cut at DIFF_PATCH_MAX_BYTES in the middle of a line or a hunk. The parser
 * classifies whatever is there and does not complain about the missing rest.
 */

export type PatchLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface PatchLine {
  kind: PatchLineKind;
  /** The line as in the patch, without its line terminator (keeps the leading "+", "-" or " "). */
  text: string;
}

export interface PatchFile {
  /** New path (`+++ b/<path>`), or the old one for deletions; from `diff --git a/X b/Y` as a fallback. */
  path: string;
  /** Set only for renames (`rename from`). */
  oldPath?: string;
  /** `Binary files ... differ` seen. */
  binary: boolean;
  /** Every line of the file section after the `diff --git` line, classified. */
  lines: PatchLine[];
}

const DIFF_GIT_PREFIX = "diff --git ";
/** Hunk header. Missing counters (`@@ -1 +1 @@`) mean 1. Group 1: old count, group 2: new count. */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** Parser state of one file section. */
interface Section {
  /** Path taken from the `diff --git a/X b/Y` line (`Y`). */
  diffPath: string;
  /** From `+++ b/<path>`; undefined when `+++ /dev/null`. */
  plusPath?: string;
  /** From `--- a/<path>`; undefined when `--- /dev/null`. */
  minusPath?: string;
  renameFrom?: string;
  renameTo?: string;
  binary: boolean;
  /** Set once the first hunk header is seen: `---` and `+++` are no longer headers after that. */
  seenHunk: boolean;
  /** Old and new lines still expected by the current hunk. Both 0 when outside a hunk. */
  oldLeft: number;
  newLeft: number;
  lines: PatchLine[];
}

/** Removes one pair of surrounding double quotes, as git does for unusual paths. */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** Removes the `a/` or `b/` prefix that git adds to the paths of `---` and `+++` lines. */
function stripSidePrefix(value: string): string {
  return value.replace(/^[ab]\//, "");
}

/** Path of a `---` or `+++` line, or undefined for `/dev/null`. */
function headerPath(value: string): string | undefined {
  // Non-git diffs append a tab and a timestamp after the path.
  const tab = value.indexOf("\t");
  const raw = tab >= 0 ? value.slice(0, tab) : value;
  if (raw === "/dev/null") return undefined;
  return stripSidePrefix(unquote(raw));
}

/**
 * Fallback path from `diff --git a/X b/Y`: whatever follows the last `b/` that starts a word
 * (preceded by a space or by the quote git uses for unusual paths).
 */
function pathFromDiffLine(line: string): string {
  const body = line.slice(DIFF_GIT_PREFIX.length);
  let index = body.lastIndexOf("b/");
  while (index > 0 && body[index - 1] !== " " && body[index - 1] !== '"') {
    index = body.lastIndexOf("b/", index - 1);
  }
  if (index < 0) return unquote(body);
  let rest = body.slice(index + 2);
  if (body[index - 1] === '"' && rest.endsWith('"')) {
    rest = rest.slice(0, -1);
  }
  return rest;
}

function newSection(diffLine: string): Section {
  return {
    diffPath: pathFromDiffLine(diffLine),
    binary: false,
    seenHunk: false,
    oldLeft: 0,
    newLeft: 0,
    lines: [],
  };
}

/** Classifies one line of a file section and updates the section state. */
function classify(section: Section, line: string): void {
  // A content line never starts with "@@", so this check is safe even inside a hunk.
  if (line.startsWith("@@")) {
    const match = HUNK_HEADER.exec(line);
    section.seenHunk = true;
    section.oldLeft = match ? (match[1] === undefined ? 1 : Number(match[1])) : 0;
    section.newLeft = match ? (match[2] === undefined ? 1 : Number(match[2])) : 0;
    section.lines.push({ kind: "hunk", text: line });
    return;
  }

  if (section.oldLeft > 0 || section.newLeft > 0) {
    // Inside a hunk the counters decide: "--- x" is a deleted line and "+++ x" an added one.
    if (line.startsWith("-")) {
      section.oldLeft = Math.max(0, section.oldLeft - 1);
      section.lines.push({ kind: "del", text: line });
      return;
    }
    if (line.startsWith("+")) {
      section.newLeft = Math.max(0, section.newLeft - 1);
      section.lines.push({ kind: "add", text: line });
      return;
    }
    if (line.startsWith(" ") || line === "") {
      section.oldLeft = Math.max(0, section.oldLeft - 1);
      section.newLeft = Math.max(0, section.newLeft - 1);
      section.lines.push({ kind: "context", text: line });
      return;
    }
    // "\ No newline at end of file" and anything unexpected: no line is consumed.
    section.lines.push({ kind: "meta", text: line });
    return;
  }

  // Outside a hunk: header or unrecognized line.
  if (!section.seenHunk) {
    if (line.startsWith("--- ")) {
      section.minusPath = headerPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      section.plusPath = headerPath(line.slice(4));
    } else if (line.startsWith("rename from ")) {
      section.renameFrom = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      section.renameTo = unquote(line.slice("rename to ".length));
    }
  }
  if (line.startsWith("Binary files ")) {
    section.binary = true;
  }
  section.lines.push({ kind: "meta", text: line });
}

function finishSection(section: Section): PatchFile {
  const path =
    section.plusPath ??
    section.renameTo ??
    section.minusPath ??
    section.renameFrom ??
    section.diffPath;
  const file: PatchFile = { path, binary: section.binary, lines: section.lines };
  if (section.renameFrom !== undefined) {
    file.oldPath = section.renameFrom;
  }
  return file;
}

/** Splits on "\n" only (U+2028 and friends are plain content) and drops a final "\r" per line. */
function splitLines(patch: string): string[] {
  const lines = patch.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  // The "\n" that ends the patch does not start a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Splits a unified git diff into files. Never throws; an empty string gives []. Text before the
 * first `diff --git` line is ignored, and a patch without any `diff --git` line gives [].
 */
export function parsePatch(patch: string): PatchFile[] {
  if (typeof patch !== "string" || patch === "") {
    return [];
  }
  const files: PatchFile[] = [];
  let section: Section | null = null;
  for (const line of splitLines(patch)) {
    if (line.startsWith(DIFF_GIT_PREFIX)) {
      if (section) files.push(finishSection(section));
      section = newSection(line);
      continue;
    }
    if (section) classify(section, line);
  }
  if (section) files.push(finishSection(section));
  return files;
}
