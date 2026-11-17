/**
 * Pure helpers for the views (no DOM). Everything here works on text that comes from the
 * model, the tools or the network, so it never interprets it.
 */

/** Max code points of the summary of tool arguments, before the ellipsis. */
const ARGS_SUMMARY_LIMIT = 120;

/** JSON.stringify(value) recortado a 120 code points con "…" final si se corta; "" si no serializa o es undefined. */
export function summarizeArgs(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return "";
  }
  if (json === undefined) {
    return "";
  }
  const { text, clipped } = clip(json, ARGS_SUMMARY_LIMIT);
  return clipped ? `${text}…` : text;
}

/** JSON.stringify(value, null, 2); if it throws or gives undefined, String(value). */
export function prettyJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json !== undefined) {
      return json;
    }
  } catch {
    // Circular structures, BigInt, ...: fall through to String(value).
  }
  try {
    return String(value);
  } catch {
    // Objects without a prototype have no string conversion.
    return "";
  }
}

/** { text, clipped }: first `max` code points (never splits a surrogate pair). */
export function clip(text: string, max: number): { text: string; clipped: boolean } {
  // `for...of` iterates by code point, so a surrogate pair is never cut in half.
  let index = 0;
  let count = 0;
  for (const char of text) {
    if (count === max) {
      return { text: text.slice(0, index), clipped: true };
    }
    index += char.length;
    count++;
  }
  return { text, clipped: false };
}

/** "850 ms" below 1000, "1.2 s" otherwise (one decimal). */
export function formatToolDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Local "HH:MM:SS" of Date.parse(createdAt) + timeoutMs; "" if createdAt is invalid. */
export function expiryTime(createdAt: string, timeoutMs: number): string {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) {
    return "";
  }
  const date = new Date(created + timeoutMs);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
