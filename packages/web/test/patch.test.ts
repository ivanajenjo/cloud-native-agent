import { describe, expect, it } from "vitest";
import { parsePatch } from "../src/patch.js";

/** Kinds of the lines of a file section, in order. */
const kinds = (file: { lines: { kind: string }[] }) => file.lines.map((line) => line.kind);

describe("parsePatch", () => {
  it("parses a modified file with one hunk", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n");

    const files = parsePatch(patch);

    expect(files).toEqual([
      {
        path: "src/a.ts",
        binary: false,
        lines: [
          { kind: "meta", text: "index 1111111..2222222 100644" },
          { kind: "meta", text: "--- a/src/a.ts" },
          { kind: "meta", text: "+++ b/src/a.ts" },
          { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
          { kind: "context", text: " one" },
          { kind: "del", text: "-two" },
          { kind: "add", text: "+TWO" },
          { kind: "context", text: " three" },
        ],
      },
    ]);
  });

  it("takes the path of a new file from +++ and marks no oldPath", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
    ].join("\n");

    const [file] = parsePatch(patch);

    expect(file?.path).toBe("new.txt");
    expect(file?.oldPath).toBeUndefined();
    expect(file?.binary).toBe(false);
    expect(kinds(file as { lines: { kind: string }[] })).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "add",
      "add",
    ]);
  });

  it("takes the path of a deleted file from --- when +++ is /dev/null", () => {
    const patch = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-gone",
      "-too",
    ].join("\n");

    const [file] = parsePatch(patch);

    expect(file?.path).toBe("old.txt");
    expect(file?.oldPath).toBeUndefined();
    expect(kinds(file as { lines: { kind: string }[] })).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "del",
      "del",
    ]);
  });

  it("parses a pure rename without hunks", () => {
    const patch = [
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 100%",
      "rename from old name.txt",
      "rename to new name.txt",
    ].join("\n");

    const files = parsePatch(patch);

    expect(files).toEqual([
      {
        path: "new name.txt",
        oldPath: "old name.txt",
        binary: false,
        lines: [
          { kind: "meta", text: "similarity index 100%" },
          { kind: "meta", text: "rename from old name.txt" },
          { kind: "meta", text: "rename to new name.txt" },
        ],
      },
    ]);
  });

  it("parses a rename with changes", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "index 5555555..6666666 100644",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-export const a = 1;",
      "+export const a = 2;",
    ].join("\n");

    const [file] = parsePatch(patch);

    expect(file?.path).toBe("src/new.ts");
    expect(file?.oldPath).toBe("src/old.ts");
    expect(kinds(file as { lines: { kind: string }[] })).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "del",
      "add",
    ]);
  });

  it("marks binary files and falls back to the diff --git path", () => {
    const patch = [
      "diff --git a/x.png b/x.png",
      "index 7777777..8888888 100644",
      "Binary files a/x.png and b/x.png differ",
    ].join("\n");

    const files = parsePatch(patch);

    expect(files).toEqual([
      {
        path: "x.png",
        binary: true,
        lines: [
          { kind: "meta", text: "index 7777777..8888888 100644" },
          { kind: "meta", text: "Binary files a/x.png and b/x.png differ" },
        ],
      },
    ]);
  });

  it("splits several files and keeps each section apart", () => {
    const patch = [
      "diff --git a/one.txt b/one.txt",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-1",
      "+uno",
      "diff --git a/two.txt b/two.txt",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1 +1 @@",
      "-2",
      "+dos",
    ].join("\n");

    const files = parsePatch(patch);

    expect(files.map((file) => file.path)).toEqual(["one.txt", "two.txt"]);
    expect(files[0]?.lines.map((line) => line.text)).toEqual([
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-1",
      "+uno",
    ]);
    expect(files[1]?.lines.map((line) => line.text)).toEqual([
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1 +1 @@",
      "-2",
      "+dos",
    ]);
  });

  it("handles several hunks in one file", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "@@ -10,2 +10,3 @@",
      " j",
      "+new",
      " k",
    ].join("\n");

    const [file] = parsePatch(patch);

    expect(kinds(file as { lines: { kind: string }[] })).toEqual([
      "meta",
      "meta",
      "hunk",
      "context",
      "del",
      "add",
      "hunk",
      "context",
      "add",
      "context",
    ]);
  });

  it("classifies a removed line starting with '-- ' and an added line starting with '++ ' inside a hunk", () => {
    const patch = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1,3 @@",
      "--- comentario sql",
      "+++ algo",
      " select 1;",
      "+-- nuevo comentario",
    ].join("\n");

    const [file] = parsePatch(patch);

    expect(file?.path).toBe("q.sql");
    expect(file?.lines.slice(2)).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
      { kind: "del", text: "--- comentario sql" },
      { kind: "add", text: "+++ algo" },
      { kind: "context", text: " select 1;" },
      { kind: "add", text: "+-- nuevo comentario" },
    ]);
  });

  it("classifies '\\ No newline at end of file' as meta without consuming a line", () => {
    const patch = [
      "diff --git a/n.txt b/n.txt",
      "--- a/n.txt",
      "+++ b/n.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");

    const [file] = parsePatch(patch);

    expect(file?.lines.slice(2)).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "del", text: "-old" },
      { kind: "meta", text: "\\ No newline at end of file" },
      { kind: "add", text: "+new" },
      { kind: "meta", text: "\\ No newline at end of file" },
    ]);
  });

  it("removes \\r from line ends", () => {
    const patch =
      "diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n";

    const files = parsePatch(patch);

    expect(files).toEqual([
      {
        path: "w.txt",
        binary: false,
        lines: [
          { kind: "meta", text: "--- a/w.txt" },
          { kind: "meta", text: "+++ b/w.txt" },
          { kind: "hunk", text: "@@ -1 +1 @@" },
          { kind: "del", text: "-a" },
          { kind: "add", text: "+b" },
        ],
      },
    ]);
  });

  it("uses 1 as the default counter in a hunk header without counters", () => {
    const patch = [
      "diff --git a/s.txt b/s.txt",
      "--- a/s.txt",
      "+++ b/s.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/t.txt b/t.txt",
    ].join("\n");

    const files = parsePatch(patch);

    expect(files).toHaveLength(2);
    expect(kinds(files[0] as { lines: { kind: string }[] })).toEqual([
      "meta",
      "meta",
      "hunk",
      "del",
      "add",
    ]);
  });

  it("treats an empty line inside a hunk as context", () => {
    const patch = [
      "diff --git a/e.txt b/e.txt",
      "--- a/e.txt",
      "+++ b/e.txt",
      "@@ -1,3 +1,3 @@",
      " first",
      "",
      "-last",
      "+LAST",
    ].join("\n");

    const [file] = parsePatch(patch);

    expect(file?.lines.slice(2)).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "context", text: " first" },
      { kind: "context", text: "" },
      { kind: "del", text: "-last" },
      { kind: "add", text: "+LAST" },
    ]);
  });

  it("unquotes a path that git quoted", () => {
    const patch = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      "index 9999999..aaaaaaa 100644",
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    const [file] = parsePatch(patch);

    expect(file?.path).toBe("caf\\303\\251.txt");
    expect(file?.oldPath).toBeUndefined();
  });

  it("falls back to the quoted diff --git path when there are no header lines", () => {
    const patch = 'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"';

    const [file] = parsePatch(patch);

    expect(file?.path).toBe("caf\\303\\251.txt");
    expect(file?.binary).toBe(false);
  });

  it("classifies a truncated patch in the middle of a hunk without throwing", () => {
    const patch = [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,5 +1,5 @@",
      " keep",
      "-removed",
      "+adde",
    ].join("\n");

    const files = parsePatch(patch);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("big.txt");
    expect(kinds(files[0] as { lines: { kind: string }[] })).toEqual([
      "meta",
      "meta",
      "hunk",
      "context",
      "del",
      "add",
    ]);
  });

  it("classifies a last line cut in the middle", () => {
    const patch = "diff --git a/c.txt b/c.txt\n--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-a\n+bc";

    const [file] = parsePatch(patch);

    expect(file?.lines.at(-1)).toEqual({ kind: "add", text: "+bc" });
  });

  it("returns [] for an empty string", () => {
    expect(parsePatch("")).toEqual([]);
  });

  it("returns [] for text without any diff --git line", () => {
    expect(parsePatch("hello\nworld\n--- not a diff\n+++ either\n@@ -1 +1 @@\n-a\n+b")).toEqual([]);
  });

  it("ignores text before the first diff --git line", () => {
    const patch = "garbage before\n" + "diff --git a/z.txt b/z.txt\n--- a/z.txt\n+++ b/z.txt\n";

    const files = parsePatch(patch);

    expect(files).toEqual([
      {
        path: "z.txt",
        binary: false,
        lines: [
          { kind: "meta", text: "--- a/z.txt" },
          { kind: "meta", text: "+++ b/z.txt" },
        ],
      },
    ]);
  });
});
