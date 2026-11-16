/** Placeholder that replaces every secret occurrence. */
export const REDACTED = "[REDACTED]";

/** Placeholder for a repeated object on the current path (a cycle). */
const CIRCULAR = "[Circular]";

const DEFAULT_MIN_LENGTH = 8;

export interface Redactor {
  /** Replaces every occurrence of every secret (and of its encodeURIComponent form, if different) with REDACTED. */
  redactString(text: string): string;
  /**
   * Deep copy of a JSON-like value with every string redacted (values, not object keys).
   * Arrays and plain objects are walked; numbers/booleans/null/undefined are returned as is.
   * Cycles must not loop forever: a repeated object is replaced by the string "[Circular]".
   * The input is never mutated.
   */
  redact<T>(value: T): T;
}

/**
 * Secrets shorter than minLength (default 8) are ignored, to avoid redacting common words.
 * undefined/empty values are ignored. Duplicates are fine. Longer secrets are replaced first
 * (so a secret that contains another one is fully redacted).
 * With no secrets, redactString/redact return the input unchanged (redact may still copy).
 */
export function createRedactor(
  secrets: Iterable<string | undefined>,
  options?: { minLength?: number },
): Redactor {
  const minLength = options?.minLength ?? DEFAULT_MIN_LENGTH;
  const needles = collectNeedles(secrets, minLength);

  const redactString = (text: string): string => {
    // Fast path: tool output can be large and rarely contains a secret.
    if (needles.length === 0 || !needles.some((needle) => text.includes(needle))) {
      return text;
    }
    // Single left-to-right pass: a replacement is never scanned again, so a short
    // needle cannot corrupt the placeholder text, and the longest match wins at each position.
    let out = "";
    let i = 0;
    while (i < text.length) {
      const needle = needles.find((n) => text.startsWith(n, i));
      if (needle === undefined) {
        out += text[i];
        i += 1;
      } else {
        out += REDACTED;
        i += needle.length;
      }
    }
    return out;
  };

  const redact = <T>(value: T): T => walk(value, redactString, []) as T;

  return { redactString, redact };
}

/**
 * Values of the secret variables in env: GITHUB_TOKEN, GH_TOKEN, AGENT_API_TOKEN, and every
 * variable whose NAME ends with _API_KEY, _TOKEN, _SECRET or _PASSWORD (case-sensitive, uppercase).
 * Empty values are skipped.
 */
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") {
      continue;
    }
    if (isSecretName(name)) {
      secrets.push(value);
    }
  }
  return secrets;
}

const EXPLICIT_SECRET_NAMES = new Set(["GITHUB_TOKEN", "GH_TOKEN", "AGENT_API_TOKEN"]);
const SECRET_SUFFIXES = ["_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD"];

function isSecretName(name: string): boolean {
  return EXPLICIT_SECRET_NAMES.has(name) || SECRET_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * Unique, non-empty needles (raw value and its URL-encoded form), longest first.
 */
function collectNeedles(secrets: Iterable<string | undefined>, minLength: number): string[] {
  const unique = new Set<string>();
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0 || secret.length < minLength) {
      continue;
    }
    unique.add(secret);
    const encoded = encodeForm(secret);
    if (encoded !== undefined && encoded !== secret && encoded.length >= minLength) {
      unique.add(encoded);
    }
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

function encodeForm(secret: string): string | undefined {
  try {
    return encodeURIComponent(secret);
  } catch {
    // Lone surrogates cannot be URI-encoded; the raw form is still redacted.
    return undefined;
  }
}

/**
 * Copies a JSON-like value, redacting strings. `ancestors` holds the objects on the current
 * path, so only real cycles are cut; a shared non-cyclic reference is copied in each place.
 */
function walk(
  value: unknown,
  redactString: (text: string) => string,
  ancestors: object[],
): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.includes(value)) {
    return CIRCULAR;
  }

  const path = [...ancestors, value];
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item, redactString, path));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = walk(item, redactString, path);
  }
  return copy;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
