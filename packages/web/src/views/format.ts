import type { SessionStatus } from "@cna/shared";

/** Pure presentation helpers for the views. No DOM here. */

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "inactiva",
  cloning: "clonando",
  running: "trabajando",
  waiting_input: "esperando respuesta",
  ready: "lista",
  closed: "cerrada",
  error: "error",
};

/** Spanish label: idle "inactiva", cloning "clonando", running "trabajando", waiting_input "esperando respuesta", ready "lista", closed "cerrada", error "error". */
export function statusLabel(status: SessionStatus): string {
  return STATUS_LABELS[status];
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** "1.2 KB", "3.4 MB", "512 B" (base 1024, one decimal for KB/MB/GB). Invalid input → "—". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) {
    return `${Math.floor(value)} B`;
  }
  // Rounding to one decimal can reach 1024 (e.g. 1048575 B): promote to the next unit.
  if (Number(value.toFixed(1)) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** "850 ms", "1.2 s", "2 min 5 s". Negative or NaN → "—". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.floor(ms)} ms`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min ${seconds} s`;
}

/** Local time "HH:MM:SS" of an ISO 8601 string; invalid → the string as is. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
