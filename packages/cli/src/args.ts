import { parseArgs } from "node:util";
import {
  DEFAULT_PORTS,
  isReplicaName,
  parseCheckpointId,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@cna/shared";

export type Command =
  | {
      name: "run";
      repo: string;
      prompt?: string; // required unless pr is set
      pr?: number; // --pr <n>: work on an existing agent/* pull request
      plan: boolean; // --plan
      baseBranch?: string; // --base <branch>
      model?: string; // --model <provider/model>
      thinking?: ThinkingLevel; // --thinking <level>
      autoPush: boolean; // --auto-push
      detach: boolean; // --detach: create the session and exit without attaching
    }
  | { name: "chat" } // alias: "attach"
  | { name: "status" }
  | { name: "stats" }
  | { name: "history" }
  | { name: "resume"; id: string; prompt?: string; detach: boolean } // cna resume <id> ["prompt"]
  | { name: "diff"; checkpoint?: number; stat: boolean } // --checkpoint <id>, --stat
  | { name: "todos" }
  | { name: "abort" }
  | { name: "close"; force: boolean } // --force
  | { name: "help" }
  | { name: "version" }
  | { name: "replicas" }; // cna replicas: lists the replicas behind edge

export interface GlobalOptions {
  /** --url > env CNA_URL > "http://127.0.0.1:8080". Must parse as an http: or https: URL; trailing "/" removed. */
  url: string;
  /** false with --no-color or a non-empty NO_COLOR env; otherwise `isTty`. */
  color: boolean;
  /** --replica > env CNA_REPLICA (empty = unset). Validated with isReplicaName. */
  replica?: string;
}

export interface ParsedArgs {
  command: Command;
  options: GlobalOptions;
}

/** Bad usage: main prints `cna: <message>` and the hint "cna help", exit code 2. */
export class UsageError extends Error {}

/** Help text (Spanish), listing every command and option above, plus CNA_URL and CNA_TOKEN. */
export const USAGE: string = `Uso:
  cna run <owner/repo> ["<prompt>"] [--pr <n>] [--plan] [--base <rama>]
                                  [--model <proveedor/modelo>] [--thinking <nivel>]
                                  [--auto-push] [--detach]
                                  Crea una sesión sobre el repo y abre el chat (o sale con --detach)
  cna chat                        Chat interactivo con la sesión actual (alias: attach)
  cna status                      Estado de la sesión actual
  cna stats                       Tokens, coste y uso del contexto de la sesión actual
  cna history                     Sesiones pasadas de esta réplica (la más reciente primero)
  cna resume <id> ["<prompt>"] [--detach]
                                  Reanuda una sesión del historial (id completo o su prefijo)
  cna diff [--checkpoint <id>] [--stat]
                                  Diff frente a la rama base (o frente a un checkpoint)
  cna todos                       Lista de tareas del agente
  cna replicas                    Réplicas detrás de edge y la sesión de cada una
  cna abort                       Aborta el turno en curso y cancela las preguntas pendientes
  cna close [--force]             Cierra la sesión y limpia el workspace
  cna help                        Muestra esta ayuda (también --help o -h)
  cna version                     Muestra la versión (también --version)

Opciones de run:
  --pr <n>            Trabaja sobre el PR n del repo, que debe ser un PR abierto del agente
                      (rama agent/*). Con --pr el prompt es opcional
  --plan              Modo plan: el agente investiga y propone antes de editar
  --base <rama>       Rama base (por defecto, la del repo; con --pr no se admite)
  --model <proveedor/modelo>
                      Modelo a usar (por defecto, el configurado)
  --thinking <nivel>  Nivel de razonamiento: ${THINKING_LEVELS.join(", ")}
  --auto-push         Hace push y PR sin preguntar
  --detach            Crea la sesión y sale sin conectarse al chat

Opciones de resume:
  --detach            Reanuda la sesión y sale sin conectarse al chat

Opciones de diff:
  --checkpoint <id>   Diff frente al checkpoint indicado (entero no negativo)
  --stat              Solo el resumen de ficheros cambiados

Opciones de close:
  --force             Cierra aunque haya cambios sin subir

Opciones globales (válidas en cualquier comando):
  --url <url>         URL de edge (por defecto, CNA_URL o http://127.0.0.1:${DEFAULT_PORTS.edgeApi})
  --replica <nombre>
                      Réplica con la que hablar (por defecto, CNA_REPLICA o la primera)
  --no-color          Salida sin colores

Variables de entorno:
  CNA_URL             URL de edge, si no se usa --url
  CNA_REPLICA         Réplica con la que hablar, si no se usa --replica
  CNA_TOKEN           Token de la API (AGENT_API_TOKEN de edge). Nunca va en la línea de comandos
  NO_COLOR            Si tiene valor, desactiva los colores
`;

const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORTS.edgeApi}`;

/** `owner/repo`: the server validates the rest. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** Options accepted by any command. */
const GLOBAL_OPTIONS = ["url", "replica", "no-color", "help", "version"] as const;

/** Positionals accepted by a command (inclusive range) and its options, besides the global ones. */
const COMMANDS: Record<string, { min: number; max: number; options: readonly string[] }> = {
  run: {
    min: 1,
    max: 2,
    options: ["pr", "plan", "base", "model", "thinking", "auto-push", "detach"],
  },
  chat: { min: 0, max: 0, options: [] },
  attach: { min: 0, max: 0, options: [] },
  status: { min: 0, max: 0, options: [] },
  stats: { min: 0, max: 0, options: [] },
  history: { min: 0, max: 0, options: [] },
  resume: { min: 1, max: 2, options: ["detach"] },
  diff: { min: 0, max: 0, options: ["checkpoint", "stat"] },
  todos: { min: 0, max: 0, options: [] },
  abort: { min: 0, max: 0, options: [] },
  close: { min: 0, max: 0, options: ["force"] },
  help: { min: 0, max: 0, options: [] },
  version: { min: 0, max: 0, options: [] },
  replicas: { min: 0, max: 0, options: [] },
};

/** Table given to parseArgs: the union of every option, checked per command afterwards. */
const OPTIONS = {
  url: { type: "string" },
  replica: { type: "string" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  pr: { type: "string" },
  plan: { type: "boolean" },
  base: { type: "string" },
  model: { type: "string" },
  thinking: { type: "string" },
  "auto-push": { type: "boolean" },
  detach: { type: "boolean" },
  checkpoint: { type: "string" },
  stat: { type: "boolean" },
  force: { type: "boolean" },
} as const;

const ALL_OPTIONS = Object.keys(OPTIONS);

/**
 * Parses `argv` (process.argv.slice(2)). Uses `parseArgs` from `node:util` (strict: true,
 * allowPositionals: true). Throws UsageError on: unknown command or option, missing/extra positionals,
 * invalid --thinking (must be one of THINKING_LEVELS from @cna/shared), invalid --checkpoint
 * (use parseCheckpointId from @cna/shared), invalid url, options not valid for the command
 * (e.g. `cna status --force`).
 */
export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined>,
  isTty: boolean,
): ParsedArgs {
  rejectTokenOption(argv);
  const { values, positionals } = parseRaw(argv);

  const options: GlobalOptions = {
    url: resolveUrl(values.url, env.CNA_URL),
    // Any non-empty NO_COLOR disables colors, as the no-color.org convention says.
    color: values["no-color"] !== true && !env.NO_COLOR && isTty,
    replica: resolveReplica(values.replica, env.CNA_REPLICA),
  };

  if (values.help === true) {
    return { command: { name: "help" }, options };
  }
  if (values.version === true) {
    return { command: { name: "version" }, options };
  }

  const [word, ...rest] = positionals;
  if (word === undefined) {
    return { command: { name: "help" }, options };
  }

  const spec = Object.hasOwn(COMMANDS, word) ? COMMANDS[word] : undefined;
  if (spec === undefined) {
    throw new UsageError(`comando desconocido: ${word}`);
  }
  checkOptionsForCommand(word, spec.options, values);
  checkPositionals(word, spec, rest.length);

  switch (word) {
    case "run":
      return { command: parseRun(values, rest), options };
    case "resume":
      return { command: parseResume(values, rest), options };
    case "chat":
    case "attach":
      return { command: { name: "chat" }, options };
    case "diff":
      return { command: parseDiff(values), options };
    case "close":
      return { command: { name: "close", force: values.force === true }, options };
    case "status":
    case "stats":
    case "history":
    case "replicas":
    case "todos":
    case "abort":
    case "help":
    case "version":
      return { command: { name: word }, options };
    default:
      throw new UsageError(`comando desconocido: ${word}`);
  }
}

/** The token only comes from CNA_TOKEN: it must never be in argv (history, `ps`). */
function rejectTokenOption(argv: string[]): void {
  for (const arg of argv) {
    if (arg === "--") {
      return;
    }
    if (arg === "--token" || arg.startsWith("--token=")) {
      throw new UsageError(
        "el token no se pasa por la línea de comandos; usa la variable CNA_TOKEN",
      );
    }
  }
}

function parseRaw(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : "";
    // Only the option name is taken from node's message: it never echoes the value.
    const name = /'(-{1,2}[^'\s<]+)/.exec(message)?.[1] ?? "opción";
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      throw new UsageError(`opción desconocida: ${name}`);
    }
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      if (/argument (missing|is ambiguous)/.test(message)) {
        throw new UsageError(`${name} necesita un valor`);
      }
      throw new UsageError(`${name} no admite valor`);
    }
    throw new UsageError("argumentos no válidos");
  }
}

/**
 * --replica > CNA_REPLICA (an empty variable counts as unset) > undefined (the default replica).
 * The message never echoes the value.
 */
function resolveReplica(
  flagValue: string | undefined,
  envValue: string | undefined,
): string | undefined {
  const name = flagValue ?? (envValue === "" ? undefined : envValue);
  if (name === undefined) {
    return undefined;
  }
  if (!isReplicaName(name)) {
    throw new UsageError("el nombre de la réplica no es válido (p. ej. agent-2)");
  }
  return name;
}

function resolveUrl(flagValue: string | undefined, envValue: string | undefined): string {
  const raw = flagValue ?? (envValue ? envValue : DEFAULT_URL);
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new UsageError("la URL no es válida; usa http:// o https://");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UsageError("la URL debe empezar por http:// o https://");
  }
  return raw.trim().replace(/\/+$/, "");
}

function checkOptionsForCommand(
  word: string,
  allowed: readonly string[],
  values: Record<string, string | boolean | undefined>,
): void {
  for (const name of ALL_OPTIONS) {
    if (values[name] === undefined) {
      continue;
    }
    if ((GLOBAL_OPTIONS as readonly string[]).includes(name) || allowed.includes(name)) {
      continue;
    }
    throw new UsageError(`la opción --${name} no es válida con «${word}»`);
  }
}

const RUN_USAGE = 'uso: cna run <owner/repo> ["<prompt>"] [--pr <n>]';
const RESUME_USAGE = 'uso: cna resume <id> ["<prompt>"] [--detach]';

/** Largest PR number accepted by --pr (the same bound as the API). */
const MAX_PR_NUMBER = 1_000_000_000;

/** Session ids from `cna history` (a UUID, or a prefix of one). */
const RESUME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function checkPositionals(word: string, spec: { min: number; max: number }, actual: number): void {
  if (actual >= spec.min && actual <= spec.max) {
    return;
  }
  if (word === "run") {
    throw new UsageError(RUN_USAGE);
  }
  if (word === "resume") {
    throw new UsageError(RESUME_USAGE);
  }
  throw new UsageError(`«${word}» no admite argumentos`);
}

function parseRun(
  values: Record<string, string | boolean | undefined>,
  [repo, second]: string[],
): Command {
  if (repo === undefined) {
    throw new UsageError(RUN_USAGE);
  }
  const pr = prOption(values.pr);
  // Without --pr the prompt is required; with --pr it is optional.
  if (pr === undefined && second === undefined) {
    throw new UsageError(RUN_USAGE);
  }
  if (!REPO_PATTERN.test(repo)) {
    throw new UsageError("el repositorio debe tener la forma <owner/repo>");
  }
  if (pr !== undefined && values.base !== undefined) {
    throw new UsageError("con --pr la rama base es la del PR");
  }
  if (second !== undefined && second.trim() === "") {
    throw new UsageError("el prompt no puede estar vacío");
  }
  const base = stringOption("base", values.base);
  const model = stringOption("model", values.model);
  const thinking = thinkingOption(values.thinking);
  return {
    name: "run",
    repo,
    prompt: second,
    pr,
    plan: values.plan === true,
    baseBranch: base,
    model,
    thinking,
    autoPush: values["auto-push"] === true,
    detach: values.detach === true,
  };
}

function parseResume(
  values: Record<string, string | boolean | undefined>,
  [id, prompt]: string[],
): Command {
  if (id === undefined) {
    throw new UsageError(RESUME_USAGE);
  }
  if (!RESUME_ID_PATTERN.test(id)) {
    throw new UsageError("el id de la sesión no es válido; usa el que muestra cna history");
  }
  if (prompt !== undefined && prompt.trim() === "") {
    throw new UsageError("el prompt no puede estar vacío");
  }
  return { name: "resume", id, prompt, detach: values.detach === true };
}

/** `--pr <n>`: an integer from 1 to MAX_PR_NUMBER, without sign or decimals. */
function prOption(value: string | boolean | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const pr = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(pr) || pr < 1 || pr > MAX_PR_NUMBER) {
    throw new UsageError("--pr debe ser un número de PR");
  }
  return pr;
}

function parseDiff(values: Record<string, string | boolean | undefined>): Command {
  const checkpointValue = values.checkpoint;
  let checkpoint: number | undefined;
  if (checkpointValue !== undefined) {
    const id = typeof checkpointValue === "string" ? parseCheckpointId(checkpointValue) : null;
    if (id === null) {
      throw new UsageError("--checkpoint debe ser un entero mayor o igual que 0");
    }
    checkpoint = id;
  }
  return { name: "diff", checkpoint, stat: values.stat === true };
}

function stringOption(name: string, value: string | boolean | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`--${name} no puede estar vacío`);
  }
  return value;
}

function thinkingOption(value: string | boolean | undefined): ThinkingLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const level = THINKING_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new UsageError(`--thinking debe ser uno de: ${THINKING_LEVELS.join(", ")}`);
  }
  return level;
}
