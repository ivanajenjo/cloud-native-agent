import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NetworkLogEntry } from "@cna/shared";

export interface NetworkLog {
  append(entry: NetworkLogEntry): Promise<void>;
  close(): Promise<void>;
}

/** Appends one JSON object per line to `filePath` (creating parent dirs with mode 0o700 and the file with mode 0o600). */
export function createFileNetworkLog(filePath: string): NetworkLog {
  let directoryReady = false;
  // Every write is chained here, so lines are written in call order and never interleave.
  // Each link swallows its own error, so the chain never rejects.
  let queue: Promise<void> = Promise.resolve();

  const writeLine = async (line: string): Promise<void> => {
    try {
      if (!directoryReady) {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        directoryReady = true;
      }
      await appendFile(filePath, line, { mode: 0o600 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`network log: cannot write to ${filePath}: ${message}`);
    }
  };

  return {
    append(entry) {
      let line: string;
      try {
        line = `${JSON.stringify(entry)}\n`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`network log: cannot serialize entry: ${message}`);
        return Promise.resolve();
      }
      queue = queue.then(() => writeLine(line));
      return queue;
    },
    close() {
      return queue;
    },
  };
}
