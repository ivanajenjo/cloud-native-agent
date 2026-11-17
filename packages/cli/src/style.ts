export type StyleName = "bold" | "dim" | "red" | "green" | "yellow" | "cyan";

const CODES: Record<StyleName, number> = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
};

const RESET = "\x1b[0m";

/** Wraps text in the ANSI codes of the styles when `enabled`; returns it unchanged otherwise. */
export function style(text: string, enabled: boolean, ...styles: StyleName[]): string {
  if (!enabled || styles.length === 0) {
    return text;
  }
  const codes = styles.map((name) => CODES[name]).join(";");
  return `\x1b[${codes}m${text}${RESET}`;
}

const REPLACEMENT = "\uFFFD";
const LINE_FEED = 0x0a;
const TAB = 0x09;

/** True for C0 controls (ESC included), DEL and C1 controls, except "\n" and "\t". */
function isControl(code: number): boolean {
  if (code === LINE_FEED || code === TAB) {
    return false;
  }
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** Turns "\r\n" into "\n", then replaces C0/C1 control characters except "\n" and "\t" (and ESC, so untrusted text cannot inject ANSI sequences) with U+FFFD. */
export function sanitize(text: string): string {
  let out = "";
  // CRLF line ends (common in tool output) become "\n"; a lone "\r" could overwrite the line.
  const normalized = text.replaceAll("\r\n", "\n");
  // Iterates by code point, so surrogate pairs (emojis) are kept whole.
  for (const char of normalized) {
    out += isControl(char.codePointAt(0) ?? 0) ? REPLACEMENT : char;
  }
  return out;
}
