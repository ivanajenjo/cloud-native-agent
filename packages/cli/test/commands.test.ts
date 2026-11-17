import type { DiffResponse, Question, SessionInfo } from "@cna/shared";
import { ApiClient, ApiClientError } from "@cna/shared/client";
import { describe, expect, it } from "vitest";
import type { Command } from "../src/args.js";
import {
  type CommandContext,
  createSession,
  describeError,
  formatDiff,
  formatSession,
  formatTodos,
  runAbort,
  runClose,
  runDiff,
  runStatus,
  runTodos,
} from "../src/commands.js";

const ESC = "\x1b";
const TOKEN = "t";

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

interface Harness {
  ctx: CommandContext;
  requests: RecordedRequest[];
  out: string[];
  err: string[];
}

/** A context whose client never touches the network: every request goes to `handler`. */
function harness(
  handler: (request: RecordedRequest) => Response | Promise<Response> = () =>
    new Response(null, { status: 204 }),
  color = false,
): Harness {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: String(input),
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    };
    requests.push(request);
    return handler(request);
  };
  const client = new ApiClient({
    baseUrl: "http://edge.test",
    token: TOKEN,
    fetch: fetch as typeof globalThis.fetch,
  });
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    client,
    output: { out: (text) => out.push(text), err: (text) => err.push(text) },
    color,
  };
  return { ctx, requests, out, err };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    status: "ready",
    repo: "owner/x",
    baseBranch: "main",
    branch: "agent/fix-1",
    model: null,
    thinking: null,
    mode: "auto",
    autoPush: false,
    createdAt: "2026-11-17T10:00:00.000Z",
    pr: null,
    suspended: false,
    pendingQuestions: [],
    ...overrides,
  };
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: "q1",
    kind: "ask_user",
    method: "input",
    title: "¿Nombre?",
    createdAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

function diffFixture(overrides: Partial<DiffResponse> = {}): DiffResponse {
  return {
    from: { kind: "base", branch: "main", commit: "abcdef1234567890" },
    files: [
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
      { path: "new.txt", status: "added", additions: 2, deletions: 0 },
      { path: "old.txt", status: "deleted", additions: 0, deletions: 4 },
      { path: "b.bin", status: "modified", additions: null, deletions: null },
    ],
    patch:
      "diff --git a/src/a.ts b/src/a.ts\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/src/a.ts\n" +
      "+++ b/src/a.ts\n" +
      "@@ -1 +1 @@\n" +
      "-old\n" +
      "+new\n",
    truncated: false,
    ...overrides,
  };
}

function runCommand(overrides: Partial<Extract<Command, { name: "run" }>> = {}) {
  return {
    name: "run" as const,
    repo: "owner/x",
    prompt: "hola",
    plan: false,
    autoPush: false,
    detach: false,
    ...overrides,
  };
}

describe("describeError", () => {
  it("explains a 401 with a fixed message that never echoes the body", () => {
    const error = new ApiClientError(401, "unauthorized", `token ${TOKEN} rechazado sk-secret`);
    const message = describeError(error);
    expect(message).toBe(
      "Token no válido o ausente: define CNA_TOKEN con el AGENT_API_TOKEN de edge",
    );
    expect(message).not.toContain("sk-secret");
  });

  it("explains a network failure (status 0)", () => {
    expect(describeError(new ApiClientError(0, "network_error", "ECONNREFUSED"))).toBe(
      "No se puede conectar con edge: ECONNREFUSED",
    );
  });

  it("explains no_session", () => {
    expect(describeError(new ApiClientError(404, "no_session", "x"))).toBe(
      "No hay ninguna sesión activa",
    );
  });

  it("explains session_exists", () => {
    expect(describeError(new ApiClientError(409, "session_exists", "x"))).toBe(
      "Ya hay una sesión en esta réplica (mira cna status o ciérrala con cna close)",
    );
  });

  it("shows the message of question_not_found, question_resolved and checkpoint_not_found", () => {
    for (const code of [
      "question_not_found",
      "question_resolved",
      "checkpoint_not_found",
    ] as const) {
      expect(describeError(new ApiClientError(404, code, "Detalle del servidor"))).toBe(
        "Detalle del servidor",
      );
    }
  });

  it("appends the code to other API errors", () => {
    expect(describeError(new ApiClientError(409, "invalid_state", "Hay commits"))).toBe(
      "Hay commits (invalid_state)",
    );
    expect(describeError(new ApiClientError(500, "unknown", "HTTP 500"))).toBe(
      "HTTP 500 (unknown)",
    );
  });

  it("uses the message of a plain Error", () => {
    expect(describeError(new Error("algo falló"))).toBe("algo falló");
  });

  it("returns a generic message for any other value", () => {
    expect(describeError("boom")).toBe("Error desconocido");
    expect(describeError(undefined)).toBe("Error desconocido");
  });

  it("sanitizes the text", () => {
    const message = describeError(new Error("a\x1b[2Jb"));
    expect(message).not.toContain(ESC);
    expect(message).toBe("a�[2Jb");
  });
});

describe("runStatus", () => {
  it("prints the session and returns 0", async () => {
    const { ctx, requests, out, err } = harness(() => json(sessionInfo()));
    expect(await runStatus(ctx)).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "http://edge.test/session",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(out.join("")).toContain("Repo: owner/x");
    expect(err).toEqual([]);
  });

  it("says there is no session on 404 and returns 0", async () => {
    const { ctx, out, err } = harness(() =>
      json({ error: "no_session", message: "No session" }, 404),
    );
    expect(await runStatus(ctx)).toBe(0);
    expect(out).toEqual(["No hay ninguna sesión activa.\n"]);
    expect(err).toEqual([]);
  });

  it("writes the error to stderr and returns 1", async () => {
    const { ctx, out, err } = harness(() =>
      json({ error: "internal_error", message: "boom" }, 500),
    );
    expect(await runStatus(ctx)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["cna: boom (internal_error)\n"]);
  });
});

describe("formatSession", () => {
  it("shows the error of a session in error", () => {
    const text = formatSession(sessionInfo({ status: "error", error: "clone falló" }), false);
    expect(text).toContain("Estado: error — clone falló\n");
  });

  it("shows the thinking level next to the model", () => {
    const text = formatSession(sessionInfo({ model: "openai/gpt-4o", thinking: "high" }), false);
    expect(text).toContain("Modelo: openai/gpt-4o · thinking high\n");
  });

  it("says the default model when none is set", () => {
    expect(formatSession(sessionInfo(), false)).toContain("Modelo: por defecto\n");
  });

  it("counts the pending questions", () => {
    const text = formatSession(
      sessionInfo({ pendingQuestions: [question(), question({ id: "q2" })] }),
      false,
    );
    expect(text).toContain("Preguntas pendientes: 2 (responde con cna chat)\n");
  });

  it("omits the pending questions line when there are none", () => {
    expect(formatSession(sessionInfo(), false)).not.toContain("Preguntas pendientes");
  });

  it("lists every field, one per line, and ends with a newline", () => {
    const text = formatSession(sessionInfo({ autoPush: true, mode: "plan" }), false);
    expect(text).toBe(
      [
        "Repo: owner/x",
        "Rama: agent/fix-1 (base: main)",
        "Estado: ready",
        "Modelo: por defecto",
        "Modo: plan",
        "Push automático: sí",
        "Creada: 2026-11-17T10:00:00.000Z",
        "",
      ].join("\n"),
    );
  });

  it("shows a dash when there is no branch", () => {
    expect(formatSession(sessionInfo({ branch: null }), false)).toContain("Rama: — (base: main)\n");
  });

  it("paints the labels in bold when color is on", () => {
    expect(formatSession(sessionInfo(), true)).toContain(`${ESC}[1mRepo:${ESC}[0m owner/x`);
  });

  it("does not use colors when color is off", () => {
    expect(formatSession(sessionInfo({ status: "error", error: "x" }), false)).not.toContain(ESC);
  });

  it("sanitizes the text from the server", () => {
    const text = formatSession(sessionInfo({ repo: "owner/\x1b[2Jx" }), false);
    expect(text).not.toContain(ESC);
  });
});

describe("runDiff", () => {
  it("prints the stat without the patch", async () => {
    const { ctx, requests, out, err } = harness(() => json(diffFixture()));
    const code = await runDiff(ctx, { name: "diff", stat: true });
    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("http://edge.test/session/diff");
    const text = out.join("");
    expect(text).toBe(
      [
        "Frente a la rama base main (abcdef1)",
        "  M  src/a.ts  +3 -1",
        "  A  new.txt  +2 -0",
        "  D  old.txt  +0 -4",
        "  M  b.bin  binario",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("diff --git");
    expect(err).toEqual([]);
  });

  it("prints the stat and the patch", async () => {
    const { ctx, out } = harness(() => json(diffFixture()));
    expect(await runDiff(ctx, { name: "diff", stat: false })).toBe(0);
    const text = out.join("");
    expect(text).toContain("\n\ndiff --git a/src/a.ts b/src/a.ts\n");
    expect(text).toContain("+new\n");
    expect(text).toContain("-old\n");
  });

  it("compares against a checkpoint with ?checkpoint=", async () => {
    const diff = diffFixture({
      from: { kind: "checkpoint", id: 2, commit: "0123456789abcdef" },
      files: [],
      patch: "",
    });
    const { ctx, requests, out } = harness(() => json(diff));
    expect(await runDiff(ctx, { name: "diff", checkpoint: 2, stat: false })).toBe(0);
    expect(requests[0]?.url).toBe("http://edge.test/session/diff?checkpoint=2");
    expect(out.join("")).toBe("Frente al checkpoint #2 (0123456)\nSin cambios.\n");
  });

  it("shows renamed files as old → new", () => {
    const text = formatDiff(
      diffFixture({
        files: [
          {
            path: "new name.ts",
            oldPath: "old name.ts",
            status: "renamed",
            additions: 1,
            deletions: 0,
          },
        ],
        patch: "",
      }),
      { stat: true, color: false },
    );
    expect(text).toContain("  R  old name.ts → new name.ts  +1 -0\n");
  });

  it("says there are no changes when the diff is empty", async () => {
    const { ctx, out } = harness(() => json(diffFixture({ files: [], patch: "" })));
    expect(await runDiff(ctx, { name: "diff", stat: false })).toBe(0);
    expect(out.join("")).toBe("Frente a la rama base main (abcdef1)\nSin cambios.\n");
  });

  it("marks a truncated patch at the end", () => {
    const text = formatDiff(diffFixture({ truncated: true }), { stat: false, color: false });
    expect(text.endsWith("(diff recortado por el servidor)\n")).toBe(true);
  });

  it("paints the patch when color is on", () => {
    const text = formatDiff(diffFixture(), { stat: false, color: true });
    expect(text).toContain(`${ESC}[32m+new${ESC}[0m`);
    expect(text).toContain(`${ESC}[31m-old${ESC}[0m`);
    expect(text).toContain(`${ESC}[36m@@ -1 +1 @@${ESC}[0m`);
    expect(text).toContain(`${ESC}[1mdiff --git a/src/a.ts b/src/a.ts${ESC}[0m`);
    expect(text).not.toContain(`${ESC}[32m+++`);
    expect(text).not.toContain(`${ESC}[31m---`);
  });

  it("writes no escape sequences when color is off", async () => {
    const { ctx, out } = harness(() => json(diffFixture({ truncated: true })), false);
    await runDiff(ctx, { name: "diff", stat: false });
    expect(out.join("")).not.toContain(ESC);
  });

  it("sanitizes paths and patch lines", async () => {
    const diff = diffFixture({
      files: [{ path: "evil\x1b[2J.ts", status: "added", additions: 1, deletions: 0 }],
      patch: "+\x1b[2Jhola\r\n",
    });
    const { ctx, out } = harness(() => json(diff), true);
    expect(await runDiff(ctx, { name: "diff", stat: false })).toBe(0);
    const text = out.join("");
    expect(text).toContain("evil�[2J.ts");
    expect(text).not.toContain("\x1b[2J");
  });
});

describe("formatTodos and runTodos", () => {
  it("marks each status", () => {
    expect(
      formatTodos([
        { id: 1, text: "a", status: "pending" },
        { id: 2, text: "b", status: "in_progress" },
        { id: 3, text: "c", status: "completed" },
      ]),
    ).toBe("  [ ] a\n  [~] b\n  [x] c\n");
  });

  it("says there are no tasks when the list is empty", () => {
    expect(formatTodos([])).toBe("Sin tareas.\n");
  });

  it("sanitizes the text", () => {
    expect(formatTodos([{ id: 1, text: "x\x1b[31m", status: "pending" }])).not.toContain(ESC);
  });

  it("prints the list from GET /session/todos", async () => {
    const { ctx, requests, out } = harness(() =>
      json({
        todos: [
          { id: 1, text: "planificar", status: "completed" },
          { id: 2, text: "codificar", status: "in_progress" },
        ],
      }),
    );
    expect(await runTodos(ctx)).toBe(0);
    expect(requests[0]).toMatchObject({ method: "GET", url: "http://edge.test/session/todos" });
    expect(out).toEqual(["  [x] planificar\n  [~] codificar\n"]);
  });
});

describe("runAbort", () => {
  it("aborts the turn and returns 0", async () => {
    const { ctx, requests, out, err } = harness();
    expect(await runAbort(ctx)).toBe(0);
    expect(requests[0]).toMatchObject({ method: "POST", url: "http://edge.test/session/abort" });
    expect(out).toEqual(["Turno abortado.\n"]);
    expect(err).toEqual([]);
  });

  it("returns 1 with the error when there is no session", async () => {
    const { ctx, out, err } = harness(() => json({ error: "no_session" }, 404));
    expect(await runAbort(ctx)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["cna: No hay ninguna sesión activa\n"]);
  });
});

describe("runClose", () => {
  it("closes the session", async () => {
    const { ctx, requests, out } = harness();
    expect(await runClose(ctx, { name: "close", force: false })).toBe(0);
    expect(requests[0]).toMatchObject({ method: "DELETE", url: "http://edge.test/session" });
    expect(out).toEqual(["Sesión cerrada.\n"]);
  });

  it("sends ?force=true with --force", async () => {
    const { ctx, requests, out } = harness();
    expect(await runClose(ctx, { name: "close", force: true })).toBe(0);
    expect(requests[0]?.url).toBe("http://edge.test/session?force=true");
    expect(out).toEqual(["Sesión cerrada.\n"]);
  });

  it("explains the unpushed changes on invalid_state without --force", async () => {
    const { ctx, out, err } = harness(() => json({ error: "invalid_state", message: "x" }, 409));
    expect(await runClose(ctx, { name: "close", force: false })).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "cna: La sesión tiene cambios sin subir. Usa cna close --force para descartarlos.\n",
    ]);
  });

  it("shows the message of invalid_state with --force", async () => {
    const { ctx, err } = harness(() =>
      json({ error: "invalid_state", message: "Hay commits sin subir" }, 409),
    );
    expect(await runClose(ctx, { name: "close", force: true })).toBe(1);
    expect(err).toEqual(["cna: Hay commits sin subir (invalid_state)\n"]);
  });
});

describe("createSession", () => {
  it("sends only the required fields for a minimal run", async () => {
    const { ctx, requests, out, err } = harness(() => json(sessionInfo({ status: "idle" }), 201));
    const info = await createSession(ctx, runCommand());
    expect(info?.status).toBe("idle");
    expect(requests[0]).toMatchObject({ method: "POST", url: "http://edge.test/session" });
    expect(requests[0]?.body).toBe('{"repo":"owner/x","prompt":"hola","mode":"auto"}');
    expect(out).toEqual(["Sesión creada: owner/x (estado: idle)\n"]);
    expect(err).toEqual([]);
  });

  it("sends every optional field that has a value", async () => {
    const { ctx, requests, out } = harness(() =>
      json(sessionInfo({ status: "running", mode: "plan" }), 201),
    );
    const info = await createSession(
      ctx,
      runCommand({
        plan: true,
        baseBranch: "dev",
        model: "openai/gpt-4o",
        thinking: "high",
        autoPush: true,
      }),
    );
    expect(info).not.toBeNull();
    expect(requests[0]?.body).toBe(
      '{"repo":"owner/x","prompt":"hola","mode":"plan","baseBranch":"dev","model":"openai/gpt-4o","thinking":"high","autoPush":true}',
    );
    expect(out.join("")).toBe(
      "Sesión creada: owner/x (estado: running)\n" +
        "Modo plan: el agente propondrá un plan antes de editar.\n",
    );
  });

  it("returns null and writes the error on session_exists", async () => {
    const { ctx, out, err } = harness(() => json({ error: "session_exists" }, 409));
    expect(await createSession(ctx, runCommand())).toBeNull();
    expect(out).toEqual([]);
    expect(err).toEqual([
      "cna: Ya hay una sesión en esta réplica (mira cna status o ciérrala con cna close)\n",
    ]);
  });
});
