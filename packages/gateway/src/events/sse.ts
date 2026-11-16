import type { StreamEvent } from "@cna/shared";
import type { EventLog } from "./event-log.js";

export interface SseOptions {
  /** Comment line ": ping" every heartbeatMs. Default 15000. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DECIMAL_INTEGER = /^\d+$/;
const encoder = new TextEncoder();

/** Parses the Last-Event-ID header: a non-negative safe integer in decimal, else 0. */
export function parseLastEventId(header: string | undefined): number {
  if (header === undefined || !DECIMAL_INTEGER.test(header)) {
    return 0;
  }
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : 0;
}

/** Formats one record: `id: <id>\nevent: <event.type>\ndata: <JSON.stringify(streamEvent)>\n\n`. */
export function formatSseRecord(event: StreamEvent): string {
  // JSON.stringify escapes \n and \r inside strings, so `data:` stays on one line.
  return `id: ${event.id}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Builds a streaming Response (status 200) with headers
 *   content-type: text/event-stream; charset=utf-8
 *   cache-control: no-cache
 *   x-accel-buffering: no
 * Order: subscribe to the log FIRST, then write the replay of log.since(lastEventId),
 * then live events; live events whose id was already sent in the replay are skipped (no duplicates, no gaps).
 * The stream starts with the comment ": connected" so headers reach the client at once.
 * If the replay is truncated, a comment ": truncated" precedes it (no invented ids); the client
 * should then reload `GET /session/messages`.
 * A `lastEventId` greater than the log's last id comes from a previous gateway process (ids are
 * per process): it is treated as 0 and the whole buffer is replayed.
 * When `signal` aborts or the client cancels the stream: unsubscribe and clear the heartbeat timer.
 */
export function createSseResponse(
  log: EventLog,
  lastEventId: number,
  signal: AbortSignal,
  options: SseOptions = {},
): Response {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Highest id already written to the client (replay or live).
  let sentUpTo = 0;
  // Live events that arrive while the replay is being written; flushed after it.
  let replaying = true;
  const pending: StreamEvent[] = [];

  /** Stops everything: listener, heartbeat, abort hook and (optionally) the stream. Idempotent. */
  const shutdown = (closeStream: boolean): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    unsubscribe?.();
    unsubscribe = undefined;
    signal.removeEventListener("abort", onAbort);
    if (closeStream) {
      try {
        controller.close();
      } catch {
        // The stream was already closed or errored.
      }
    }
  };

  const onAbort = (): void => shutdown(true);

  const write = (chunk: string): void => {
    if (closed) {
      return;
    }
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // enqueue throws once the stream is closed: treat it as a client disconnect.
      shutdown(false);
    }
  };

  const sendLive = (event: StreamEvent): void => {
    if (closed || event.id <= sentUpTo) {
      return;
    }
    sentUpTo = event.id;
    write(formatSseRecord(event));
  };

  const onLive = (event: StreamEvent): void => {
    if (replaying) {
      pending.push(event);
      return;
    }
    sendLive(event);
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (signal.aborted) {
        shutdown(true);
        return;
      }

      // Subscribe before reading the replay so no event can fall in between.
      unsubscribe = log.subscribe(onLive);
      sentUpTo = log.lastId;

      write(": connected\n\n");
      const replay = log.since(lastEventId > log.lastId ? 0 : lastEventId);
      if (replay.truncated) {
        write(": truncated\n\n");
      }
      for (const event of replay.events) {
        sentUpTo = Math.max(sentUpTo, event.id);
        write(formatSseRecord(event));
      }
      replaying = false;
      for (const event of pending.splice(0)) {
        sendLive(event);
      }

      signal.addEventListener("abort", onAbort, { once: true });
      heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    },
    cancel() {
      shutdown(false);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}
