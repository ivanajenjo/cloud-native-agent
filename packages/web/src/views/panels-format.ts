import type { Checkpoint, DiffFileStatus, NetworkDecisionReason } from "@cna/shared";

/** Pure formatting helpers of the diff and network panels. No DOM. */

const REASON_LABELS: Record<NetworkDecisionReason, string> = {
  audit: "auditoría",
  allowlist: "allowlist",
  provider: "proveedor",
  service: "servicio",
  user_once: "permitido una vez",
  user_always: "permitido siempre",
  user_denied: "denegado por el usuario",
  ask_timeout: "sin respuesta",
  no_session: "sin sesión",
  not_allowed: "no permitido",
  internal_destination: "destino interno",
  port_not_allowed: "puerto no permitido",
  invalid_target: "destino no válido",
  dns_error: "error de DNS",
  unknown_client: "cliente desconocido",
};

const STATUS_LETTERS: Record<DiffFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

const BYTE_UNITS = ["KB", "MB", "GB"] as const;

/** Spanish label of each reason; unknown values come back unchanged. */
export function reasonLabel(reason: NetworkDecisionReason): string {
  const label: string | undefined = REASON_LABELS[reason];
  return label ?? reason;
}

/** "A", "M", "D", "R". */
export function statusLetter(status: DiffFileStatus): string {
  const letter: string | undefined = STATUS_LETTERS[status];
  return letter ?? status;
}

/** First 7 characters. */
export function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

/** "inicio" for reason "start", "ejecución" for "run". */
export function checkpointReasonLabel(reason: Checkpoint["reason"]): string {
  return reason === "start" ? "inicio" : "ejecución";
}

/** "512 B", "1.5 KB", "2.0 MB" (base 1024). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Local "HH:MM:SS"; invalid → the input. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
