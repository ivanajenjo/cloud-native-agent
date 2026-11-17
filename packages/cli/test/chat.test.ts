import type { DiffResponse, Question, SessionEvent, SessionInfo } from "@cna/shared";
import { ApiClient } from "@cna/shared/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_HELP, runChat } from "../src/chat.js";

const TOKEN = "tok-secreto-123";
const TS = "2026-11-17T10:00:00.000Z";
const encoder = new TextEncoder();

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

const SESSION: SessionInfo = {
  id: "s1",
  status: "idle",
  repo: "octo/hello",
  baseBranch: "main",
  branch: "agent/fix-1",
  model: null,
  thinking: null,
  mode: "auto",
  autoPush: false,
  createdAt: TS,
  pendingQuestions: [],
};

const DIFF: DiffResponse = {
  from: { kind: "base", branch: "main", commit: "abcdef1234567890" },
  files: [],
  patch: "",
  truncated: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function defaultResponse(request: Recorded): Response {
  const { method, path } = request;
  if (method === "GET" && path === "/session") return json(SESSION);
  if (method === "GET" && path === "/session/todos") return json({ todos: [] });
  if (method === "GET" && path === "/session/diff") return json(DIFF);
  if (method === "POST" && path === "/session/messages") return json({ disposition: "started" });
  return new Response(null, { status: 204 });
}

/**
 * Fake edge: GET /session/events returns a stream the test feeds with `emit`; the other requests
 * are recorded and answered by `respond` (or by defaultResponse when it returns undefined).
 */
class FakeEdge {
  readonly requests: Recorded[] = [];
  respond: (request: Recorded) => Response | undefined = () => undefined;
  eventsStatus = 200;
  private readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private nextId = 1;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const request: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.requests.push(request);
    if (request.path === "/session/events") {
      if (this.eventsStatus !== 200) {
        return json(
          { error: "unauthorized", message: `token ${TOKEN} rechazado` },
          this.eventsStatus,
        );
      }
      return new Response(this.stream, { headers: { "content-type": "text/event-stream" } });
    }
    return this.respond(request) ?? defaultResponse(request);
  }) as typeof globalThis.fetch;

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  /** Writes one SSE record with the next id. */
  emit(event: SessionEvent): void {
    const id = this.nextId++;
    const record = { id, ts: TS, event };
    this.emitRaw(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(record)}\n\n`);
  }

  emitRaw(text: string): void {
    this.controller.enqueue(encoder.encode(text));
  }

  requestsTo(method: string, path: string): Recorded[] {
    return this.requests.filter((request) => request.method === method && request.path === path);
  }
}

/** Input that the test controls: `push` a line, `end` ends it (EOF). */
function lineQueue() {
  const lines: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          while (lines.length === 0 && !ended) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const line = lines.shift();
          if (line === undefined) return { value: undefined, done: true };
          return { value: line, done: false };
        },
      };
    },
  };
  return {
    source,
    push(line: string): void {
      lines.push(line);
      notify();
    },
    end(): void {
      ended = true;
      notify();
    },
  };
}

const stops: AbortController[] = [];

afterEach(() => {
  for (const stop of stops) stop.abort();
  stops.length = 0;
});

/** Starts a chat. `eventsStatus` must be set here: the fake fetch runs synchronously at start. */
function start(
  options: { eventsStatus?: number; respond?: (request: Recorded) => Response | undefined } = {},
) {
  const edge = new FakeEdge();
  edge.eventsStatus = options.eventsStatus ?? 200;
  if (options.respond) edge.respond = options.respond;
  const input = lineQueue();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stop = new AbortController();
  stops.push(stop);
  const run = runChat({
    client: new ApiClient({ baseUrl: "http://edge.test", token: TOKEN, fetch: edge.fetch }),
    output: { out: (text) => stdout.push(text), err: (text) => stderr.push(text) },
    color: false,
    input: input.source,
    signal: stop.signal,
    retryDelayMs: 1,
  });
  return {
    edge,
    input,
    stop,
    run,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

type Chat = ReturnType<typeof start>;

/** Waits until the chat has printed `text` on stdout. */
async function expectOut(chat: Chat, text: string): Promise<void> {
  await vi.waitFor(() => expect(chat.stdout()).toContain(text));
}

/** Waits until the chat has written `text` on stderr. */
async function expectErr(chat: Chat, text: string): Promise<void> {
  await vi.waitFor(() => expect(chat.stderr()).toContain(text));
}

/**
 * Lines are handled in order: once a barrier (a notify event or a /help line) has shown its effect,
 * everything sent before it has been processed.
 */
async function barrier(chat: Chat, label: string): Promise<void> {
  chat.edge.emit({ type: "notify", level: "info", message: label });
  await expectOut(chat, label);
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: "q1",
    kind: "ask_user",
    method: "input",
    title: "¿Nombre?",
    createdAt: TS,
    ...overrides,
  };
}

const SELECT_QUESTION = question({
  id: "q1",
  method: "select",
  title: "¿Cuál?",
  options: ["alfa", "beta", "gamma"],
});

describe("runChat: mensajes", () => {
  it("prints the greeting and sends a text line as a followUp message", async () => {
    const chat = start();
    await expectOut(chat, "Conectado. Escribe un mensaje o /help.\n");
    chat.input.push("hola agente");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/messages")).toEqual([
        {
          method: "POST",
          path: "/session/messages",
          authorization: `Bearer ${TOKEN}`,
          body: { text: "hola agente", mode: "followUp" },
        },
      ]),
    );
  });

  it("warns when the message is queued", async () => {
    const chat = start();
    chat.edge.respond = (request) =>
      request.path === "/session/messages" ? json({ disposition: "queued" }) : undefined;
    chat.input.push("otra cosa");
    await expectOut(chat, "(en cola: se enviará cuando termine el turno)\n");
  });

  it("sends /steer <texto> as a steer message", async () => {
    const chat = start();
    chat.input.push("/steer x");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/messages")[0]?.body).toEqual({
        text: "x",
        mode: "steer",
      }),
    );
  });

  it("reports /steer without text and does not send anything", async () => {
    const chat = start();
    chat.input.push("/steer   ");
    await expectErr(chat, "Uso: /steer <texto>");
    expect(chat.edge.requestsTo("POST", "/session/messages")).toHaveLength(0);
  });

  it("ignores empty lines", async () => {
    const chat = start();
    chat.input.push("   ");
    await barrier(chat, "fin-vacio");
    expect(chat.edge.requestsTo("POST", "/session/messages")).toHaveLength(0);
    expect(chat.stderr()).toBe("");
  });

  it("reports unknown commands", async () => {
    const chat = start();
    chat.input.push("/foo bar");
    await expectErr(chat, "Comando desconocido: /foo. Escribe /help.\n");
  });

  it("prints the help", async () => {
    const chat = start();
    chat.input.push("/help");
    await expectOut(chat, CHAT_HELP);
  });

  it("aborts the turn with /abort", async () => {
    const chat = start();
    chat.input.push("/abort");
    await expectOut(chat, "Turno abortado.\n");
    expect(chat.edge.requestsTo("POST", "/session/abort")).toHaveLength(1);
  });

  it("prints /status with the session, or says there is none", async () => {
    const chat = start();
    chat.input.push("/status");
    await expectOut(chat, "Repo: octo/hello");

    const empty = start();
    empty.edge.respond = (request) =>
      request.path === "/session" ? json({ error: "no_session", message: "x" }, 404) : undefined;
    empty.input.push("/status");
    await expectOut(empty, "No hay ninguna sesión activa.\n");
  });

  it("prints /todos and /diff", async () => {
    const chat = start();
    chat.input.push("/todos");
    await expectOut(chat, "Sin tareas.\n");
    chat.input.push("/diff");
    await expectOut(chat, "Frente a la rama base main");
  });

  it("reports API errors without leaving the chat", async () => {
    const chat = start();
    chat.edge.respond = (request) =>
      request.path === "/session/messages"
        ? json({ error: "invalid_state", message: "el agente está ocupado" }, 409)
        : undefined;
    chat.input.push("uno");
    await expectErr(chat, "cna: el agente está ocupado (invalid_state)\n");
    chat.edge.respond = () => undefined;
    chat.input.push("dos");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/messages")).toHaveLength(2),
    );
  });

  it("prints the events of the session", async () => {
    const chat = start();
    chat.edge.emit({ type: "message_delta", contentIndex: 0, delta: "hola mundo" });
    await expectOut(chat, "hola mundo");
  });

  it("says when the replay is truncated", async () => {
    const chat = start();
    chat.edge.emitRaw(": truncated\n\n");
    await expectOut(chat, "(el historial está incompleto)\n");
  });
});

describe("runChat: preguntas", () => {
  it("prints a select question and answers with the option of the number", async () => {
    const chat = start();
    chat.edge.emit({ type: "question", question: SELECT_QUESTION });
    await expectOut(chat, "  2) beta\n");
    chat.input.push("2");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/answers/q1")).toEqual([
        {
          method: "POST",
          path: "/session/answers/q1",
          authorization: `Bearer ${TOKEN}`,
          body: { value: "beta" },
        },
      ]),
    );
  });

  it("answers a question already pending at start before the replay arrives", async () => {
    const chat = start({
      respond: (request) =>
        request.method === "GET" && request.path === "/session"
          ? json({ ...SESSION, status: "waiting_input", pendingQuestions: [SELECT_QUESTION] })
          : undefined,
    });
    chat.input.push("3");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/answers/q1")).toEqual([
        expect.objectContaining({ body: { value: "gamma" } }),
      ]),
    );
    expect(chat.edge.requestsTo("POST", "/session/messages")).toEqual([]);
    expect(chat.stdout()).toContain("  3) gamma\n");
  });

  it("reports an invalid answer and sends nothing", async () => {
    const chat = start();
    chat.edge.emit({ type: "question", question: SELECT_QUESTION });
    await expectOut(chat, "Elige un número");
    chat.input.push("9");
    await expectErr(chat, "Opción no válida: elige un número del 1 al 3\n");
    chat.input.push("/help");
    await expectOut(chat, CHAT_HELP);
    expect(chat.edge.requestsTo("POST", "/session/answers/q1")).toHaveLength(0);
  });

  it("answers a confirm question with s", async () => {
    const chat = start();
    chat.edge.emit({
      type: "question",
      question: question({ id: "c1", kind: "confirm", method: "confirm", title: "¿Borrar?" }),
    });
    await expectOut(chat, "¿Confirmas? [s/n]");
    chat.input.push("s");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/answers/c1")[0]?.body).toEqual({
        confirmed: true,
      }),
    );
  });

  it("collects an editor answer until a line with a dot", async () => {
    const chat = start();
    chat.edge.emit({
      type: "question",
      question: question({ id: "e1", kind: "ask_user", method: "editor", title: "Mensaje" }),
    });
    await expectOut(chat, 'termina con una línea que solo tenga "."');
    chat.input.push("primera");
    chat.input.push("segunda");
    chat.input.push(".");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/answers/e1")[0]?.body).toEqual({
        value: "primera\nsegunda",
      }),
    );
  });

  it("cancels a question with /cancel", async () => {
    const chat = start();
    chat.edge.emit({ type: "question", question: question() });
    await expectOut(chat, "¿Nombre?");
    chat.input.push("/cancel");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/answers/q1")[0]?.body).toEqual({
        cancelled: true,
      }),
    );
  });

  it("cancels a multiline question with /cancel and sends no lines", async () => {
    const chat = start();
    chat.edge.emit({
      type: "question",
      question: question({ id: "e2", method: "editor", title: "Mensaje" }),
    });
    await expectOut(chat, "Escribe la respuesta");
    chat.input.push("algo");
    chat.input.push("/cancel");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/answers/e2")[0]?.body).toEqual({
        cancelled: true,
      }),
    );
  });

  it("keeps the question active when the answer request fails", async () => {
    const chat = start();
    let calls = 0;
    chat.edge.respond = (request) => {
      if (request.path !== "/session/answers/q1") return undefined;
      calls += 1;
      return calls === 1 ? json({ error: "internal", message: "fallo" }, 500) : undefined;
    };
    chat.edge.emit({ type: "question", question: question() });
    await expectOut(chat, "¿Nombre?");
    chat.input.push("Ana");
    await expectErr(chat, "cna: fallo (internal)\n");
    chat.input.push("Ana");
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/messages")).toHaveLength(0),
    );
  });

  it("shows the next queued question after answering the first one", async () => {
    const chat = start();
    chat.edge.emit({ type: "question", question: question({ id: "q1", title: "Primera" }) });
    chat.edge.emit({ type: "question", question: question({ id: "q2", title: "Segunda" }) });
    await expectOut(chat, "Primera");
    await barrier(chat, "tras-encolar");
    expect(chat.stdout()).not.toContain("Segunda");

    chat.input.push("uno");
    await expectOut(chat, "Segunda");
    expect(chat.edge.requestsTo("POST", "/session/answers/q1")[0]?.body).toEqual({ value: "uno" });
  });

  it("reports a resolved active question and shows the next one", async () => {
    const chat = start();
    chat.edge.emit({ type: "question", question: question({ id: "q1", title: "Primera" }) });
    chat.edge.emit({ type: "question", question: question({ id: "q2", title: "Segunda" }) });
    await expectOut(chat, "Primera");
    chat.edge.emit({ type: "question_resolved", questionId: "q1", outcome: "timeout" });
    await expectOut(chat, "(pregunta resuelta)\n");
    await expectOut(chat, "Segunda");
  });

  it("sends normal lines again once the only question is resolved", async () => {
    const chat = start();
    chat.edge.emit({ type: "question", question: question() });
    await expectOut(chat, "¿Nombre?");
    chat.edge.emit({ type: "question_resolved", questionId: "q1", outcome: "cancelled" });
    await expectOut(chat, "(pregunta resuelta)\n");
    chat.input.push("hola");
    await vi.waitFor(() =>
      expect(chat.edge.requestsTo("POST", "/session/messages")[0]?.body).toEqual({
        text: "hola",
        mode: "followUp",
      }),
    );
    expect(chat.edge.requestsTo("POST", "/session/answers/q1")).toHaveLength(0);
  });
});

describe("runChat: fin del chat", () => {
  it("ends with 0 on /quit", async () => {
    const chat = start();
    chat.input.push("/quit");
    await expect(chat.run).resolves.toBe(0);
  });

  it("ends with 0 on /exit while a question is active", async () => {
    const chat = start();
    chat.edge.emit({ type: "question", question: question() });
    await expectOut(chat, "¿Nombre?");
    chat.input.push("/exit");
    await expect(chat.run).resolves.toBe(0);
  });

  it("ends with 0 at EOF", async () => {
    const chat = start();
    chat.input.end();
    await expect(chat.run).resolves.toBe(0);
  });

  it("ends with 0 when the signal aborts", async () => {
    const chat = start();
    await expectOut(chat, "Conectado");
    chat.stop.abort();
    await expect(chat.run).resolves.toBe(0);
  });

  it("ends with 1 and a token message on a 401 from the event stream, without waiting for input", async () => {
    const chat = start({ eventsStatus: 401 });
    const code = await chat.run;
    expect(code).toBe(1);
    expect(chat.stderr()).toContain("Token no válido o ausente: define CNA_TOKEN");
    expect(chat.stderr()).not.toContain(TOKEN);
  });
});

describe("CHAT_HELP", () => {
  it("lists the commands and the multiline rule", () => {
    for (const text of [
      "/help",
      "/quit",
      "/exit",
      "/abort",
      "/status",
      "/todos",
      "/diff",
      "/steer <texto>",
      "/cancel",
      "«.»",
    ]) {
      expect(CHAT_HELP).toContain(text);
    }
  });
});
