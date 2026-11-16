import type { NetworkLogEntry } from "@cna/shared";

/** In-memory buffer of the most recent network log entries, served by `GET /network/log`. */
export interface RecentNetworkLog {
  /** Stores a copy of `entry`; the oldest entry is dropped when the buffer is full. */
  append(entry: NetworkLogEntry): void;
  /** The `limit` most recent entries, oldest first. Copies. */
  list(limit: number): NetworkLogEntry[];
}

/** Circular buffer that keeps at most `capacity` entries. */
export function createRecentNetworkLog(capacity: number): RecentNetworkLog {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("capacity must be a positive integer");
  }
  const slots: Array<NetworkLogEntry | undefined> = new Array<NetworkLogEntry | undefined>(
    capacity,
  ).fill(undefined);
  /** Index of the slot the next entry goes to. */
  let next = 0;
  let size = 0;

  return {
    append(entry) {
      slots[next] = { ...entry };
      next = (next + 1) % capacity;
      size = Math.min(size + 1, capacity);
    },
    list(limit) {
      const count = Math.max(0, Math.min(Math.floor(limit), size));
      const result: NetworkLogEntry[] = [];
      // The oldest of the last `count` entries sits `count` slots behind `next`.
      for (let back = count; back > 0; back--) {
        const entry = slots[(next - back + capacity) % capacity];
        if (entry !== undefined) {
          result.push({ ...entry });
        }
      }
      return result;
    },
  };
}
