const PORT_PATTERN = /^\d+$/;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Parses a TCP port from an environment variable value.
 * Accepts only decimal integers in [1, 65535]; `undefined` yields `fallback`.
 * Throws if the value is present but invalid.
 */
export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!PORT_PATTERN.test(value)) {
    throw new Error(`invalid port "${value}": expected an integer between 1 and 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`invalid port "${value}": expected an integer between 1 and 65535`);
  }
  return port;
}
