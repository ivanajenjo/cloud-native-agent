import type { SessionEvent, StreamEvent } from "@cna/shared";

export interface EventLogOptions {
  /** Max events kept for replay. Default 5000. The oldest are dropped. */
  capacity?: number;
  /** Injectable clock. Default () => new Date(). */
  now?: () => Date;
}

export interface ReplayResult {
  events: StreamEvent[];
  /** True when events after `afterId` were already dropped from the buffer (the client missed some). */
  truncated: boolean;
}

type Listener = (event: StreamEvent) => void;

const DEFAULT_CAPACITY = 5000;

/**
 * In-memory, bounded log of the session events, used for SSE replay.
 * Ids are per process: they keep growing across `clear()`.
 */
export class EventLog {
  private readonly capacity: number;
  private readonly now: () => Date;
  private buffer: StreamEvent[] = [];
  private nextId = 1;
  /** True once an event has been evicted because of `capacity` (not by `clear`). */
  private evicted = false;
  private readonly subscriptions = new Set<{ listener: Listener }>();

  constructor(options: EventLogOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`EventLog capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.now = options.now ?? (() => new Date());
  }

  /** Assigns id = lastId + 1 (first is 1) and ts = now().toISOString(), stores it, notifies listeners synchronously in subscription order, returns it. A listener that throws must not prevent the others nor break append (catch and ignore). */
  append(event: SessionEvent): StreamEvent {
    const stored: StreamEvent = {
      id: this.nextId,
      ts: this.now().toISOString(),
      event,
    };
    this.nextId += 1;

    this.buffer.push(stored);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
      this.evicted = true;
    }

    // Copy the subscriptions: a listener may unsubscribe while we iterate.
    for (const subscription of [...this.subscriptions]) {
      if (!this.subscriptions.has(subscription)) {
        continue;
      }
      try {
        subscription.listener(stored);
      } catch {
        // A failing listener must not affect the others nor the append.
      }
    }

    return stored;
  }

  /** Buffered events with id > afterId, oldest first. afterId 0 → whole buffer. truncated = (afterId < (oldest buffered id) - 1) and at least one event was ever dropped. */
  since(afterId: number): ReplayResult {
    const events = this.buffer.filter((stored) => stored.id > afterId);
    const oldest = this.buffer[0];
    const truncated = this.evicted && oldest !== undefined && afterId < oldest.id - 1;
    return { events, truncated };
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    const subscription = { listener };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** Last assigned id (0 if none). */
  get lastId(): number {
    return this.nextId - 1;
  }

  /**
   * Number of active subscriptions. Intended for tests only, to check that
   * unsubscribing (e.g. on SSE abort) really removes the listener.
   */
  get listenerCount(): number {
    return this.subscriptions.size;
  }

  /** Empties the buffer (new session). Ids keep growing: never reset. */
  clear(): void {
    this.buffer = [];
  }
}
