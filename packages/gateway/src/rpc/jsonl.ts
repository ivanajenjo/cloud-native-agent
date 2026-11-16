import { StringDecoder } from "node:string_decoder";

/** Maximum number of characters of an offending line reported in a parse error. */
const MAX_ERROR_LINE_LENGTH = 200;

export interface JsonlParseError {
  /** The offending line, truncated to its first 200 characters. */
  line: string;
  message: string;
}

export interface JsonlDecoder {
  /** Feed a chunk of stdout. Buffers or strings are accepted. */
  push(chunk: Buffer | string): void;
  /** Stream ended: parse whatever remains in the buffer as a last record (if non-blank). */
  end(): void;
}

/**
 * Splits only on "\n" and strips one trailing "\r". Blank lines (empty or only whitespace) are skipped.
 * Each line is JSON.parse'd and passed to onRecord. A line that fails to parse calls onError and decoding continues.
 * Multi-byte UTF-8 sequences split across Buffer chunks must be decoded correctly (use node:string_decoder's StringDecoder).
 */
export function createJsonlDecoder(
  onRecord: (value: unknown) => void,
  onError: (error: JsonlParseError) => void,
): JsonlDecoder {
  const utf8 = new StringDecoder("utf8");
  // Pending text that does not yet form a complete line. `lineStart` marks where the
  // current (unfinished) line begins and `searchFrom` where the next "\n" search resumes,
  // so each character is scanned at most once.
  let pending = "";
  let lineStart = 0;
  let searchFrom = 0;
  let ended = false;

  const handleLine = (raw: string): void => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      onError({
        line: line.slice(0, MAX_ERROR_LINE_LENGTH),
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    onRecord(value);
  };

  const drain = (): void => {
    let newline = pending.indexOf("\n", searchFrom);
    while (newline !== -1) {
      handleLine(pending.slice(lineStart, newline));
      lineStart = newline + 1;
      searchFrom = lineStart;
      newline = pending.indexOf("\n", searchFrom);
    }
    // Keep only the unfinished line so the buffer does not grow without bound.
    pending = pending.slice(lineStart);
    lineStart = 0;
    searchFrom = pending.length;
  };

  return {
    push(chunk: Buffer | string): void {
      if (ended) {
        throw new Error("decoder ended");
      }
      pending += typeof chunk === "string" ? chunk : utf8.write(chunk);
      drain();
    },
    end(): void {
      if (ended) {
        return;
      }
      ended = true;
      pending += utf8.end();
      drain();
      const rest = pending.slice(lineStart);
      pending = "";
      lineStart = 0;
      searchFrom = 0;
      handleLine(rest);
    },
  };
}

/** JSON.stringify(value) + "\n". */
export function encodeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
