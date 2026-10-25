/**
 * `TOAST_WS_PORT` as a port number, or undefined when unset. A value that is
 * not a whole number in 1–65535 fails at startup, naming the variable;
 * `Number("abc")` is NaN, which `?? 37149` would not catch.
 */
export function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`TOAST_WS_PORT must be a port number (1-65535), got "${value}".`);
  }
  return n;
}
