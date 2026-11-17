/**
 * Incremental parser of `text/event-stream` (WHATWG "event stream interpretation").
 * Browser and Node compatible: no `node:*` imports.
 */

export type SseRecord =
  | { kind: "event"; id?: string; event?: string; data: string }
  | { kind: "comment"; text: string };

const BOM = "\uFEFF";

function stripLeadingSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

export class SseParser {
  /** Incomplete line waiting for its terminator. */
  private buffer = "";
  /** The last chunk ended with `\r`; a `\n` at the start of the next chunk belongs to it. */
  private skipLineFeed = false;
  private atStart = true;
  /** Fields of the event being accumulated. */
  private dataLines: string[] = [];
  private eventName: string | undefined;
  private eventId: string | undefined;

  /** Feeds decoded text. Returns the records completed by this chunk, in order. */
  push(chunk: string): SseRecord[] {
    let text = chunk;
    if (this.atStart && text.length > 0) {
      this.atStart = false;
      if (text.startsWith(BOM)) text = text.slice(1);
    }
    if (this.skipLineFeed && text.length > 0) {
      this.skipLineFeed = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    if (text.length === 0) return [];

    const data = this.buffer + text;
    this.buffer = "";
    const records: SseRecord[] = [];
    let start = 0;
    let i = 0;
    while (i < data.length) {
      const char = data.charAt(i);
      if (char !== "\r" && char !== "\n") {
        i++;
        continue;
      }
      this.processLine(data.slice(start, i), records);
      if (char === "\r") {
        if (i + 1 < data.length) {
          if (data.charAt(i + 1) === "\n") i++;
        } else {
          this.skipLineFeed = true;
        }
      }
      i++;
      start = i;
    }
    this.buffer = data.slice(start);
    return records;
  }

  private processLine(line: string, records: SseRecord[]): void {
    if (line.length === 0) {
      this.dispatch(records);
      return;
    }
    if (line.startsWith(":")) {
      records.push({ kind: "comment", text: stripLeadingSpace(line.slice(1)) });
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : stripLeadingSpace(line.slice(colon + 1));
    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.eventName = value;
        break;
      case "id":
        if (!value.includes("\u0000")) this.eventId = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
  }

  private dispatch(records: SseRecord[]): void {
    const dataLines = this.dataLines;
    const eventName = this.eventName;
    const eventId = this.eventId;
    this.dataLines = [];
    this.eventName = undefined;
    this.eventId = undefined;
    if (dataLines.length === 0) return;
    records.push({
      kind: "event",
      data: dataLines.join("\n"),
      ...(eventId !== undefined ? { id: eventId } : {}),
      ...(eventName !== undefined ? { event: eventName } : {}),
    });
  }
}
