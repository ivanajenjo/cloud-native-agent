import type { AnswerRequest, Question, StreamEvent } from "@cna/shared";
import { type ApiClient, type EventStreamItem, followEvents } from "@cna/shared/client";
import { describeError, formatDiff, formatSession, formatTodos, type Output } from "./commands.js";
import { formatQuestion, isMultiline, parseAnswer } from "./questions.js";
import { EventPrinter } from "./render.js";
import { sanitize } from "./style.js";

export interface ChatOptions {
  client: ApiClient;
  output: Output;
  color: boolean;
  /** Lines typed by the user, without line terminators. Ends at EOF (Ctrl-D). */
  input: AsyncIterable<string>;
  /** Aborting it ends the chat (returns 0). */
  signal?: AbortSignal;
  /** Passed to followEvents. Default 0 (full replay of the current session). */
  lastEventId?: number;
  /** Passed to followEvents. Default 1000. */
  retryDelayMs?: number;
}

export const CHAT_HELP: string = `Comandos del chat:
  /help               Muestra esta ayuda
  /quit, /exit        Sale del chat (la sesión sigue en marcha)
  /abort              Aborta el turno en curso y cancela las preguntas pendientes
  /status             Estado de la sesión
  /todos              Lista de tareas del agente
  /diff               Diff frente a la rama base (solo el resumen de ficheros)
  /steer <texto>      Envía un mensaje que se inyecta en el turno en curso
  /cancel             Cancela la pregunta activa (cuando hay una pregunta)

Cualquier otra línea se envía al agente como mensaje.
Una pregunta multilínea se termina con una línea que solo tenga «.».
`;

const GREETING = "Conectado. Escribe un mensaje o /help.\n";

/** Mutable state of one chat: printer, question queue and the input in progress. */
class ChatRun {
  private printer: EventPrinter;
  /** Unresolved questions, in arrival order. */
  private pending: Question[] = [];
  /** The question that receives the next input line. */
  private active: Question | null = null;
  /** Answered questions still waiting for `question_resolved`. */
  private readonly answered = new Set<string>();
  /** Lines of the multiline question in progress. */
  private lines: string[] = [];

  constructor(
    private readonly client: ApiClient,
    private readonly output: Output,
    private readonly color: boolean,
    private readonly chatSignal: AbortSignal,
    private readonly finish: (code: number) => void,
  ) {
    this.printer = new EventPrinter({ color });
  }

  /** Follows the event stream until the chat ends. Never rejects. */
  async follow(lastEventId: number, retryDelayMs: number): Promise<void> {
    try {
      for await (const item of followEvents(this.client, {
        signal: this.chatSignal,
        lastEventId,
        retryDelayMs,
      })) {
        this.handleItem(item);
      }
    } catch (error) {
      if (this.chatSignal.aborted) return;
      this.output.err(`cna: ${describeError(error)}\n`);
      this.finish(1);
    }
  }

  /** Reads the input line by line, in order. Never rejects. */
  async readInput(input: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of input) {
        if (this.chatSignal.aborted) return;
        let quit = false;
        try {
          quit = await this.handleLine(line);
        } catch (error) {
          this.output.err(`cna: ${describeError(error)}\n`);
        }
        if (quit) {
          this.finish(0);
          return;
        }
      }
      this.finish(0);
    } catch (error) {
      this.output.err(`cna: ${describeError(error)}\n`);
      this.finish(1);
    }
  }

  private out(text: string): void {
    this.output.out(text);
  }

  private err(text: string): void {
    this.output.err(text);
  }

  private handleItem(item: EventStreamItem): void {
    switch (item.kind) {
      case "truncated":
        this.out("(el historial está incompleto)\n");
        return;
      case "reset":
        this.out("(el servidor se reinició)\n");
        this.printer = new EventPrinter({ color: this.color });
        this.pending = [];
        this.answered.clear();
        this.setActive(null);
        return;
      case "event":
        this.handleEvent(item.event);
        return;
    }
  }

  private handleEvent(event: StreamEvent): void {
    const inner = event.event;
    const text = this.printer.format(inner);
    if (text !== "") this.out(text);

    switch (inner.type) {
      case "question":
        if (!this.pending.some((question) => question.id === inner.question.id)) {
          this.pending.push(inner.question);
        }
        this.activateNext();
        return;
      case "question_resolved": {
        const id = inner.questionId;
        this.pending = this.pending.filter((question) => question.id !== id);
        this.answered.delete(id);
        if (this.active?.id === id) {
          this.setActive(null);
          this.out("(pregunta resuelta)\n");
          this.activateNext();
        }
        return;
      }
      default:
        return;
    }
  }

  private setActive(question: Question | null): void {
    this.active = question;
    this.lines = [];
  }

  /** Makes the first unanswered pending question active and prints it, if there is none active. */
  private activateNext(): void {
    if (this.active !== null) return;
    const next = this.pending.find((question) => !this.answered.has(question.id));
    if (next === undefined) return;
    this.setActive(next);
    this.out(formatQuestion(next, this.color));
  }

  /** Handles one input line. Returns true when the chat must end (/quit, /exit). */
  private async handleLine(line: string): Promise<boolean> {
    const trimmed = line.trim();
    if (trimmed === "/quit" || trimmed === "/exit") return true;
    if (trimmed === "/help") {
      this.out(CHAT_HELP);
      return false;
    }
    if (trimmed === "/abort") {
      await this.client.abort();
      this.out("Turno abortado.\n");
      return false;
    }
    if (this.active !== null) {
      await this.handleAnswerLine(this.active, line);
      return false;
    }
    await this.handleMessageLine(line, trimmed);
    return false;
  }

  /** A line typed while a question is active: part of the answer, or the answer itself. */
  private async handleAnswerLine(question: Question, line: string): Promise<void> {
    const trimmed = line.trim();
    let text = line;
    if (isMultiline(question)) {
      if (trimmed === "/cancel") {
        await this.submit(question, { cancelled: true });
        return;
      }
      if (trimmed !== ".") {
        this.lines.push(line);
        return;
      }
      text = this.lines.join("\n");
    }
    const parsed = parseAnswer(question, text);
    if (!parsed.ok) {
      this.err(`${parsed.error}\n`);
      return;
    }
    await this.submit(question, parsed.answer);
  }

  private async submit(question: Question, answer: AnswerRequest): Promise<void> {
    await this.client.answer(question.id, answer);
    // If the question was resolved while the request was in flight, there is nothing left to do.
    if (this.active?.id !== question.id) return;
    this.answered.add(question.id);
    this.setActive(null);
    this.activateNext();
  }

  /** A line typed without a pending question: a command or a message to the agent. */
  private async handleMessageLine(line: string, trimmed: string): Promise<void> {
    if (trimmed === "") return;
    if (!trimmed.startsWith("/")) {
      await this.send(line, "followUp");
      return;
    }
    const word = trimmed.split(/\s+/)[0] ?? trimmed;
    switch (word) {
      case "/status": {
        const info = await this.client.getSession();
        this.out(
          info === null ? "No hay ninguna sesión activa.\n" : formatSession(info, this.color),
        );
        return;
      }
      case "/todos":
        this.out(formatTodos(await this.client.todos()));
        return;
      case "/diff": {
        const diff = await this.client.diff();
        this.out(formatDiff(diff, { stat: true, color: this.color }));
        return;
      }
      case "/steer": {
        const text = trimmed.slice(word.length).trim();
        if (text === "") {
          this.err("Uso: /steer <texto>\n");
          return;
        }
        await this.send(text, "steer");
        return;
      }
      default:
        this.err(`Comando desconocido: ${sanitize(word)}. Escribe /help.\n`);
    }
  }

  private async send(text: string, mode: "steer" | "followUp"): Promise<void> {
    const response = await this.client.postMessage({ text, mode });
    if (response.disposition === "queued") {
      this.out("(en cola: se enviará cuando termine el turno)\n");
    }
  }
}

/** Interactive chat. Exit code: 0 on /quit, EOF or abort; 1 on a 401 from the event stream. */
export async function runChat(options: ChatOptions): Promise<number> {
  const { client, output, color, input, signal, lastEventId = 0, retryDelayMs = 1000 } = options;

  // Internal controller: it ends the chat and closes the SSE when runChat returns, for any reason.
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const chatSignal = controller.signal;

  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (code: number): void => resolveDone(code);
  chatSignal.addEventListener("abort", () => finish(0), { once: true });

  try {
    output.out(GREETING);
    const run = new ChatRun(client, output, color, chatSignal, finish);
    void run.follow(lastEventId, retryDelayMs);
    void run.readInput(input);
    return await done;
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", onParentAbort);
  }
}
