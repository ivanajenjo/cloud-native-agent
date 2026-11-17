/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Patterns that would let untrusted content reach the DOM as HTML (ADR-0010 §5). */
const FORBIDDEN = [
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "document.write",
  "eval(",
  "new Function",
  "srcdoc",
];

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const INDEX_HTML = fileURLToPath(new URL("../index.html", import.meta.url));

/** Recursively lists the `.ts` files under `dir`. */
function listTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("no HTML injection in the web UI", () => {
  const files = [...listTypeScriptFiles(SRC_DIR), INDEX_HTML];

  it("finds the source files, so the scan is not vacuous", () => {
    expect(files.some((file) => file.endsWith("dom.ts"))).toBe(true);
  });

  for (const file of files) {
    it(`does not use forbidden patterns in ${file}`, () => {
      const content = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN) {
        expect(content.includes(pattern), `${file} contains "${pattern}"`).toBe(false);
      }
    });
  }
});
