import type {
  CreateSessionRequest,
  DiffResponse,
  HistoryEntry,
  SessionInfo,
  SessionStats,
  TodoItem,
  TodoStatus,
} from "@cna/shared";
import { type ApiClient, ApiClientError } from "@cna/shared/client";
import type { Command } from "./args.js";
import { sanitize, style } from "./style.js";

/** Ids of at least this length are complete (a UUID): they are not looked up in the history. */
const FULL_SESSION_ID_LENGTH = 36;

const NOT_IN_HISTORY_MESSAGE = "No existe esa sesión en el historial";

export interface Output {
  /** stdout; the text includes its own "\n". */
  out(text: string): void;
  /** stderr; the text includes its own "\n". */
  err(text: string): void;
}

export interface CommandContext {
  client: ApiClient;
  output: Output;
  color: boolean;
}

const UNAUTHORIZED_MESSAGE =
  "Token no válido o ausente: define CNA_TOKEN con el AGENT_API_TOKEN de edge";
const NO_SESSION_MESSAGE = "No hay ninguna sesión activa";
const SESSION_EXISTS_MESSAGE =
  "Ya hay una sesión en esta réplica (mira cna status o ciérrala con cna close)";
const UNPUSHED_CHANGES_MESSAGE =
  "La sesión tiene cambios sin subir. Usa cna close --force para descartarlos.";

const TODO_MARKS: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: "~",
  completed: "x",
};

/** Spanish message for any error thrown by the client (never includes the token). */
export function describeError(error: unknown): string {
  return sanitize(describeRaw(error));
}

function describeRaw(error: unknown): string {
  if (error instanceof ApiClientError) {
    // The 401 message is fixed: the body of the answer is never shown.
    if (error.status === 401) return UNAUTHORIZED_MESSAGE;
    if (error.status === 0) return `No se puede conectar con edge: ${error.message}`;
    switch (error.code) {
      case "no_session":
        return NO_SESSION_MESSAGE;
      case "session_exists":
        return SESSION_EXISTS_MESSAGE;
      case "question_not_found":
      case "question_resolved":
      case "checkpoint_not_found":
        return error.message;
      case "history_not_found":
        return NOT_IN_HISTORY_MESSAGE;
      default:
        return `${error.message} (${error.code})`;
    }
  }
  if (error instanceof Error) return error.message;
  return "Error desconocido";
}

/** Writes "cna: <message>" to stderr and returns the exit code 1. */
function fail(ctx: CommandContext, error: unknown): number {
  ctx.output.err(`cna: ${describeError(error)}\n`);
  return 1;
}

/** Multi-line summary of a session (ends with "\n"). */
export function formatSession(info: SessionInfo, color: boolean): string {
  const bold = (text: string) => style(text, color, "bold");
  const branch = info.branch === null ? "—" : sanitize(info.branch);
  const base = info.baseBranch === null ? "—" : sanitize(info.baseBranch);
  const state =
    info.error !== undefined && info.error !== ""
      ? style(`error — ${sanitize(info.error)}`, color, "red")
      : sanitize(info.status);
  let model = info.model === null ? "por defecto" : sanitize(info.model);
  if (info.thinking !== null) model += ` · thinking ${sanitize(info.thinking)}`;

  const lines = [
    `${bold("Repo:")} ${sanitize(info.repo)}`,
    `${bold("Rama:")} ${branch} (base: ${base})`,
    ...(info.pr === null ? [] : [`${bold("PR:")} #${info.pr}`]),
    `${bold("Estado:")} ${state}`,
    ...(info.suspended
      ? [`${bold("Pi:")} en pausa por inactividad (arranca con el siguiente mensaje)`]
      : []),
    `${bold("Modelo:")} ${model}`,
    `${bold("Modo:")} ${sanitize(info.mode)}`,
    `${bold("Push automático:")} ${info.autoPush ? "sí" : "no"}`,
    `${bold("Creada:")} ${sanitize(info.createdAt)}`,
  ];
  if (info.pendingQuestions.length > 0) {
    lines.push(
      `${bold("Preguntas pendientes:")} ${info.pendingQuestions.length} (responde con cna chat)`,
    );
  }
  return lines.map((line) => `${line}\n`).join("");
}

const FILE_MARKS: Record<DiffResponse["files"][number]["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

/** Colors one line of a unified diff by its first characters. */
function colorPatchLine(line: string, color: boolean): string {
  if (line.startsWith("+++") || line.startsWith("---")) return line;
  if (line.startsWith("+")) return style(line, color, "green");
  if (line.startsWith("-")) return style(line, color, "red");
  if (line.startsWith("@@")) return style(line, color, "cyan");
  if (line.startsWith("diff --git") || line.startsWith("index ")) {
    return style(line, color, "bold");
  }
  return line;
}

/**
 * Diff as text: header, one line per file, then the colored patch unless `stat` (ends with "\n").
 */
export function formatDiff(diff: DiffResponse, options: { stat: boolean; color: boolean }): string {
  const { stat, color } = options;
  const source = diff.from;
  const sha = source.commit.slice(0, 7);
  const header =
    source.kind === "base"
      ? `Frente a la rama base ${sanitize(source.branch)} (${sha})`
      : `Frente al checkpoint #${source.id} (${sha})`;

  let out = `${header}\n`;
  if (diff.files.length === 0) {
    out += "Sin cambios.\n";
  }
  for (const file of diff.files) {
    const mark = FILE_MARKS[file.status];
    const path =
      file.status === "renamed" && file.oldPath !== undefined
        ? `${sanitize(file.oldPath)} → ${sanitize(file.path)}`
        : sanitize(file.path);
    const counts =
      file.additions === null || file.deletions === null
        ? "binario"
        : `+${file.additions} -${file.deletions}`;
    out += `  ${mark}  ${path}  ${counts}\n`;
  }

  if (!stat && diff.patch !== "") {
    // sanitize before splitting: it also turns "\r\n" into "\n" and removes ESC from the patch.
    const patch = sanitize(diff.patch).replace(/\n$/, "");
    out += "\n";
    out += patch
      .split("\n")
      .map((line) => colorPatchLine(line, color))
      .join("\n");
    out += "\n";
  }

  if (diff.truncated) {
    out += `${style("(diff recortado por el servidor)", color, "yellow")}\n`;
  }
  return out;
}

/** Cost in dollars with two decimals; "<$0.01" for amounts between 0 and 0.01. */
function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.01) {
    return "<$0.01";
  }
  return `$${cost.toFixed(2)}`;
}

/** Token usage, cost and context of the session (ends with "\n"). */
export function formatStats(stats: SessionStats, color: boolean): string {
  const bold = (text: string) => style(text, color, "bold");
  const { tokens, messages, context } = stats;

  let contextText: string;
  if (context === null) {
    contextText = "desconocido";
  } else if (context.tokens === null || context.percent === null) {
    contextText = "recién compactado";
  } else {
    contextText = `${context.tokens} de ${context.window} (${Math.round(context.percent)} %)`;
  }

  const lines = [
    `${bold("Coste:")} ${formatCost(stats.cost)}`,
    `${bold("Tokens:")} ${tokens.total} (entrada ${tokens.input}, salida ${tokens.output}, caché leída ${tokens.cacheRead}, caché escrita ${tokens.cacheWrite})`,
    `${bold("Mensajes:")} ${messages.user} tuyos, ${messages.assistant} del agente, ${messages.toolCalls} llamadas a tools`,
    `${bold("Contexto:")} ${contextText}`,
  ];
  return lines.map((line) => `${line}\n`).join("");
}

/** The history of the replica, one line per session (ends with "\n"); empty → a fixed message. */
export function formatHistory(entries: HistoryEntry[], color: boolean): string {
  if (entries.length === 0) {
    return "Todavía no hay sesiones.\n";
  }
  let out = "";
  let anyResumable = false;
  for (const entry of entries) {
    const id = sanitize(entry.id).slice(0, 8);
    const when = sanitize(entry.createdAt.slice(0, 16)).replace("T", " ");
    const pr = entry.pr === null ? "" : ` PR #${entry.pr}`;
    const branch = entry.branch === null ? "—" : sanitize(entry.branch);
    const state = entry.closedAt === null ? "actual" : sanitize(entry.status);
    const cost = entry.stats === null ? "—" : formatCost(entry.stats.cost);
    let line = `${id}  ${when}  ${sanitize(entry.repo)}${pr}  ${branch}  ${state}  ${cost}`;
    if (entry.resumable) {
      line += `  ${style("[reanudable]", color, "green")}`;
      anyResumable = true;
    }
    out += `${line}\n`;
  }
  if (anyResumable) {
    out += "Retoma una con: cna resume <id>\n";
  }
  return out;
}

/** Task list (ends with "\n"); empty → "Sin tareas.\n". */
export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "Sin tareas.\n";
  }
  return todos.map((todo) => `  [${TODO_MARKS[todo.status]}] ${sanitize(todo.text)}\n`).join("");
}

/** `cna status`: prints the session, or says there is none. */
export async function runStatus(ctx: CommandContext): Promise<number> {
  try {
    const info = await ctx.client.getSession();
    if (info === null) {
      ctx.output.out("No hay ninguna sesión activa.\n");
      return 0;
    }
    ctx.output.out(formatSession(info, ctx.color));
    return 0;
  } catch (error) {
    return fail(ctx, error);
  }
}

/** `cna stats`. */
export async function runStats(ctx: CommandContext): Promise<number> {
  try {
    const stats = await ctx.client.stats();
    ctx.output.out(formatStats(stats, ctx.color));
    return 0;
  } catch (error) {
    return fail(ctx, error);
  }
}

/** `cna history`. */
export async function runHistory(ctx: CommandContext): Promise<number> {
  try {
    const entries = await ctx.client.history();
    ctx.output.out(formatHistory(entries, ctx.color));
    return 0;
  } catch (error) {
    return fail(ctx, error);
  }
}

/** `cna diff [--checkpoint <id>] [--stat]`. */
export async function runDiff(
  ctx: CommandContext,
  command: Extract<Command, { name: "diff" }>,
): Promise<number> {
  try {
    const diff = await ctx.client.diff(command.checkpoint);
    ctx.output.out(formatDiff(diff, { stat: command.stat, color: ctx.color }));
    return 0;
  } catch (error) {
    return fail(ctx, error);
  }
}

/** `cna todos`. */
export async function runTodos(ctx: CommandContext): Promise<number> {
  try {
    const todos = await ctx.client.todos();
    ctx.output.out(formatTodos(todos));
    return 0;
  } catch (error) {
    return fail(ctx, error);
  }
}

/** `cna abort`. */
export async function runAbort(ctx: CommandContext): Promise<number> {
  try {
    await ctx.client.abort();
    ctx.output.out("Turno abortado.\n");
    return 0;
  } catch (error) {
    return fail(ctx, error);
  }
}

/** `cna close [--force]`. */
export async function runClose(
  ctx: CommandContext,
  command: Extract<Command, { name: "close" }>,
): Promise<number> {
  try {
    await ctx.client.closeSession({ force: command.force });
    ctx.output.out("Sesión cerrada.\n");
    return 0;
  } catch (error) {
    if (error instanceof ApiClientError && error.code === "invalid_state" && !command.force) {
      ctx.output.err(`cna: ${UNPUSHED_CHANGES_MESSAGE}\n`);
      return 1;
    }
    return fail(ctx, error);
  }
}

/**
 * POST /session from a `run` command; writes "Sesión creada: …" and returns the info, or writes the
 * error and returns null.
 */
export async function createSession(
  ctx: CommandContext,
  command: Extract<Command, { name: "run" }>,
): Promise<SessionInfo | null> {
  const body: CreateSessionRequest = { repo: command.repo };
  if (command.prompt !== undefined) body.prompt = command.prompt;
  if (command.pr !== undefined) body.pr = command.pr;
  body.mode = command.plan ? "plan" : "auto";
  if (command.baseBranch !== undefined) body.baseBranch = command.baseBranch;
  if (command.model !== undefined) body.model = command.model;
  if (command.thinking !== undefined) body.thinking = command.thinking;
  if (command.autoPush) body.autoPush = true;

  try {
    const info = await ctx.client.createSession(body);
    const target = info.pr === null ? sanitize(info.repo) : `${sanitize(info.repo)} PR #${info.pr}`;
    let text = `Sesión creada: ${target} (estado: ${sanitize(info.status)})\n`;
    if (info.mode === "plan") {
      text += "Modo plan: el agente propondrá un plan antes de editar.\n";
    }
    ctx.output.out(text);
    return info;
  } catch (error) {
    fail(ctx, error);
    return null;
  }
}

/**
 * Full id of the history entry the user names. A short id (a prefix shown by `cna history`) is
 * looked up in GET /session/history; it must match exactly one entry.
 */
async function resolveHistoryId(ctx: CommandContext, id: string): Promise<string> {
  if (id.length >= FULL_SESSION_ID_LENGTH) {
    return id;
  }
  const matches = (await ctx.client.history()).filter((entry) => entry.id.startsWith(id));
  const [only] = matches;
  if (only === undefined) {
    throw new Error(NOT_IN_HISTORY_MESSAGE);
  }
  if (matches.length > 1) {
    throw new Error("El id es ambiguo: escribe más caracteres");
  }
  return only.id;
}

/**
 * `cna resume <id> ["prompt"]`: reopens a past session. Writes "Sesión reanudada: …" and returns
 * the info, or writes the error and returns null.
 */
export async function resumeSession(
  ctx: CommandContext,
  command: Extract<Command, { name: "resume" }>,
): Promise<SessionInfo | null> {
  try {
    const id = await resolveHistoryId(ctx, command.id);
    const body = command.prompt !== undefined ? { prompt: command.prompt } : {};
    const info = await ctx.client.resumeSession(id, body);
    const branch = info.branch === null ? "—" : sanitize(info.branch);
    ctx.output.out(
      `Sesión reanudada: ${sanitize(info.repo)} en ${branch} (estado: ${sanitize(info.status)})\n`,
    );
    return info;
  } catch (error) {
    fail(ctx, error);
    return null;
  }
}
