/** Pure formatting helpers of the history and usage panels. No DOM. */

/** Invalid input (negative, NaN, infinite) is shown as this dash. */
const INVALID = "—";

/** Units of tokens above one thousand, ascending. */
const TOKEN_UNITS = [
  { divisor: 1_000, suffix: "k" },
  { divisor: 1_000_000, suffix: "M" },
  { divisor: 1_000_000_000, suffix: "G" },
] as const;

/**
 * Cost in the provider's currency (USD): "$0.00" for 0, "<$0.01" below one cent, otherwise two
 * decimals with a dot ("$0.45", "$12.30"). Negative or NaN → "—".
 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return INVALID;
  }
  if (value === 0) {
    return "$0.00";
  }
  if (value < 0.01) {
    return "<$0.01";
  }
  return `$${value.toFixed(2)}`;
}

/**
 * Token count with a unit: below 1000 it is the integer ("950"); from 1000 on, one decimal while
 * the scaled value is below 10 ("1.2k", "9.9k"), and no decimal from 10 on ("105k", "15M").
 * A trailing ".0" is dropped ("1000" → "1k", "1000000" → "1M"). Rounding up to 1000 of a unit
 * moves to the next unit, so 999999 gives "1M" and never "1000k". Note that 9950 gives "9.9k"
 * because 9.95 is stored just below 9.95 and `toFixed(1)` rounds it down.
 * Negative, NaN or infinite → "—".
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return INVALID;
  }
  const count = Math.round(value);
  if (count < 1000) {
    return String(count);
  }
  for (const { divisor, suffix } of TOKEN_UNITS) {
    const scaled = count / divisor;
    const digits = scaled < 10 ? scaled.toFixed(1) : String(Math.round(scaled));
    const label = digits.endsWith(".0") ? digits.slice(0, -2) : digits;
    if (Number(label) < 1000) {
      return `${label}${suffix}`;
    }
  }
  // Beyond the last unit (1000G and up): keep the largest unit, the count is still readable.
  return `${Math.round(count / 1_000_000_000)}G`;
}

/** Local "YYYY-MM-DD HH:MM"; invalid → the input. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
