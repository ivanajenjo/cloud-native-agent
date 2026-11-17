import type { SessionStats } from "@cna/shared";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number, or undefined for anything else (absent, null, string, NaN, Infinity). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseContext(value: unknown): SessionStats["context"] {
  if (!isObject(value)) {
    return null;
  }
  const window = finiteNumber(value.contextWindow);
  if (window === undefined) {
    return null;
  }
  return {
    tokens: finiteNumber(value.tokens) ?? null,
    window,
    percent: finiteNumber(value.percent) ?? null,
  };
}

/**
 * Translates the `data` of Pi's get_session_stats response. Returns null unless `tokens` has the five numbers
 * (input, output, cacheRead, cacheWrite, total) and `cost` is a number. `messages` from userMessages/assistantMessages/toolCalls
 * (missing or non-number → 0). `context` from `contextUsage`: null if absent or without a numeric `contextWindow`;
 * `tokens`/`percent` keep null when Pi sends null. Never throws; non-finite numbers count as missing.
 */
export function parseSessionStats(data: unknown): SessionStats | null {
  if (!isObject(data)) {
    return null;
  }
  const tokens = data.tokens;
  if (!isObject(tokens)) {
    return null;
  }
  const input = finiteNumber(tokens.input);
  const output = finiteNumber(tokens.output);
  const cacheRead = finiteNumber(tokens.cacheRead);
  const cacheWrite = finiteNumber(tokens.cacheWrite);
  const total = finiteNumber(tokens.total);
  const cost = finiteNumber(data.cost);
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    total === undefined ||
    cost === undefined
  ) {
    return null;
  }
  return {
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost,
    messages: {
      user: finiteNumber(data.userMessages) ?? 0,
      assistant: finiteNumber(data.assistantMessages) ?? 0,
      toolCalls: finiteNumber(data.toolCalls) ?? 0,
    },
    context: parseContext(data.contextUsage),
  };
}
