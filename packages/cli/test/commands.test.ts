import type {
  DiffResponse,
  HistoryEntry,
  Question,
  ReplicaSummary,
  SessionInfo,
  SessionStats,
} from "@cna/shared";
import { ApiClient, ApiClientError } from "@cna/shared/client";
import { describe, expect, it } from "vitest";
import type { Command } from "../src/args.js";
import {
  type CommandContext,
  createSession,
  describeError,
  formatDiff,
  formatHistory,
  formatReplicas,
  formatSession,
  formatStats,
  formatTodos,
  resumeSession,
  runAbort,
  runClose,
  runDiff,
  runHistory,
  runReplicas,
  runStats,
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

  it("explains replica_not_found and points to cna replicas", () => {
    expect(describeError(new ApiClientError(404, "replica_not_found", "x"))).toBe(
      "No existe esa réplica (mira cna replicas)",
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

describe("createSession with a pull request", () => {
  it("sends pr and no prompt when the run has no prompt", async () => {
    const { ctx, requests, out, err } = harness(() =>
      json(sessionInfo({ status: "idle", pr: 12 }), 201),
    );
    const info = await createSession(ctx, runCommand({ prompt: undefined, pr: 12 }));
    expect(info?.pr).toBe(12);
    expect(requests[0]?.body).toBe('{"repo":"owner/x","pr":12,"mode":"auto"}');
    expect(out).toEqual(["Sesión creada: owner/x PR #12 (estado: idle)\n"]);
    expect(err).toEqual([]);
  });

  it("sends the prompt together with pr when both are given", async () => {
    const { ctx, requests } = harness(() => json(sessionInfo({ status: "running", pr: 12 }), 201));
    await createSession(ctx, runCommand({ prompt: "revisa", pr: 12 }));
    expect(requests[0]?.body).toBe('{"repo":"owner/x","prompt":"revisa","pr":12,"mode":"auto"}');
  });
});

describe("formatSession with a pull request and suspension", () => {
  it("shows the PR number", () => {
    expect(formatSession(sessionInfo({ pr: 12 }), false)).toContain("PR: #12\n");
  });

  it("omits the PR line without a PR", () => {
    expect(formatSession(sessionInfo(), false)).not.toContain("PR:");
  });

  it("says that Pi is paused when the session is suspended", () => {
    expect(formatSession(sessionInfo({ suspended: true }), false)).toContain(
      "Pi: en pausa por inactividad (arranca con el siguiente mensaje)\n",
    );
  });

  it("omits the Pi line when the session is not suspended", () => {
    expect(formatSession(sessionInfo(), false)).not.toContain("Pi:");
  });
});

const STATS: SessionStats = {
  tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
  cost: 0.45,
  messages: { user: 5, assistant: 5, toolCalls: 12 },
  context: { tokens: 60000, window: 200000, percent: 30 },
};

describe("formatStats", () => {
  it("prints cost, tokens, messages and context", () => {
    expect(formatStats(STATS, false)).toBe(
      [
        "Coste: $0.45",
        "Tokens: 105000 (entrada 50000, salida 10000, caché leída 40000, caché escrita 5000)",
        "Mensajes: 5 tuyos, 5 del agente, 12 llamadas a tools",
        "Contexto: 60000 de 200000 (30 %)",
        "",
      ].join("\n"),
    );
  });

  it("says the context was just compacted when its tokens and percent are null", () => {
    const text = formatStats(
      { ...STATS, context: { tokens: null, window: 200000, percent: null } },
      false,
    );
    expect(text).toContain("Contexto: recién compactado\n");
  });

  it("says the context is unknown when it is null", () => {
    expect(formatStats({ ...STATS, context: null }, false)).toContain("Contexto: desconocido\n");
  });

  it("shows amounts under one cent as <$0.01", () => {
    expect(formatStats({ ...STATS, cost: 0.004 }, false)).toContain("Coste: <$0.01\n");
    expect(formatStats({ ...STATS, cost: 0.005 }, false)).toContain("Coste: <$0.01\n");
  });

  it("shows zero cost as $0.00 and a cent as $0.01", () => {
    expect(formatStats({ ...STATS, cost: 0 }, false)).toContain("Coste: $0.00\n");
    expect(formatStats({ ...STATS, cost: 0.01 }, false)).toContain("Coste: $0.01\n");
  });

  it("paints the labels in bold when color is on", () => {
    expect(formatStats(STATS, true)).toContain(`${ESC}[1mCoste:${ESC}[0m $0.45`);
    expect(formatStats(STATS, false)).not.toContain(ESC);
  });
});

describe("runStats", () => {
  it("prints GET /session/stats and returns 0", async () => {
    const { ctx, requests, out, err } = harness(() => json(STATS));
    expect(await runStats(ctx)).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "http://edge.test/session/stats",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(out.join("")).toContain("Coste: $0.45\n");
    expect(err).toEqual([]);
  });

  it("writes the error to stderr and returns 1", async () => {
    const { ctx, out, err } = harness(() => json({ error: "no_session", message: "x" }, 404));
    expect(await runStats(ctx)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["cna: No hay ninguna sesión activa\n"]);
  });
});

const SESSION_ID = "3f2a9c1b-0d4e-4f5a-8b6c-7d8e9f0a1b2c";
const OTHER_ID = "9a8b7c6d-1111-4222-8333-444455556666";

function historyEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: SESSION_ID,
    repo: "owner/x",
    baseBranch: "main",
    branch: "agent/fix-1",
    pr: null,
    mode: "auto",
    model: null,
    createdAt: "2026-11-17T10:00:00.000Z",
    closedAt: "2026-11-17T11:00:00.000Z",
    status: "closed",
    stats: null,
    resumable: false,
    ...overrides,
  };
}

describe("formatHistory", () => {
  it("says there are no sessions when the list is empty", () => {
    expect(formatHistory([], false)).toBe("Todavía no hay sesiones.\n");
  });

  it("prints one line per session, with the short id, the current one and the cost", () => {
    const text = formatHistory(
      [
        historyEntry({ resumable: true, stats: STATS }),
        historyEntry({
          id: OTHER_ID,
          repo: "octo/hello",
          pr: 7,
          branch: null,
          closedAt: null,
          status: "running",
        }),
      ],
      false,
    );
    expect(text).toBe(
      [
        "3f2a9c1b  2026-11-17 10:00  owner/x  agent/fix-1  closed  $0.45  [reanudable]",
        "9a8b7c6d  2026-11-17 10:00  octo/hello PR #7  —  actual  —",
        "Retoma una con: cna resume <id>",
        "",
      ].join("\n"),
    );
  });

  it("paints [reanudable] in green when color is on", () => {
    const text = formatHistory([historyEntry({ resumable: true })], true);
    expect(text).toContain(`  ${ESC}[32m[reanudable]${ESC}[0m\n`);
  });

  it("omits the resume hint when no session can be resumed", () => {
    const text = formatHistory([historyEntry({ stats: STATS })], false);
    expect(text).not.toContain("Retoma");
    expect(text).not.toContain("[reanudable]");
    expect(text).toContain("  closed  $0.45\n");
  });

  it("sanitizes the text from the server", () => {
    const text = formatHistory([historyEntry({ repo: "owner/\x1b[2Jx" })], false);
    expect(text).not.toContain(ESC);
    expect(text).toContain("owner/�[2Jx");
  });
});

describe("runHistory", () => {
  it("prints GET /session/history and returns 0", async () => {
    const { ctx, requests, out, err } = harness(() =>
      json({ sessions: [historyEntry({ resumable: true })] }),
    );
    expect(await runHistory(ctx)).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "http://edge.test/session/history",
    });
    expect(out.join("")).toContain("3f2a9c1b  2026-11-17 10:00  owner/x");
    expect(err).toEqual([]);
  });

  it("writes the error to stderr and returns 1", async () => {
    const { ctx, out, err } = harness(() =>
      json({ error: "internal_error", message: "boom" }, 500),
    );
    expect(await runHistory(ctx)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["cna: boom (internal_error)\n"]);
  });
});

function resumeCommand(
  overrides: Partial<Extract<Command, { name: "resume" }>> = {},
): Extract<Command, { name: "resume" }> {
  return { name: "resume", id: SESSION_ID, detach: false, ...overrides };
}

/** Routes the history endpoints of a fake edge; any other request gets a 404. */
function historyHandler(sessions: HistoryEntry[]) {
  return (request: RecordedRequest): Response => {
    if (request.method === "GET" && request.url === "http://edge.test/session/history") {
      return json({ sessions });
    }
    if (request.method === "POST" && request.url.endsWith("/resume")) {
      const id = decodeURIComponent(request.url.split("/").at(-2) ?? "");
      if (id === SESSION_ID) {
        return json(sessionInfo({ id, status: "ready", branch: "agent/fix-1" }), 201);
      }
    }
    return json({ error: "history_not_found", message: "x" }, 404);
  };
}

describe("resumeSession", () => {
  it("resumes a session by its full id with an empty body", async () => {
    const { ctx, requests, out, err } = harness(historyHandler([historyEntry()]));
    const info = await resumeSession(ctx, resumeCommand());
    expect(info?.status).toBe("ready");
    const post = requests.find((request) => request.method === "POST");
    expect(post).toMatchObject({
      url: `http://edge.test/session/history/${SESSION_ID}/resume`,
      authorization: `Bearer ${TOKEN}`,
      body: "{}",
    });
    expect(out).toEqual(["Sesión reanudada: owner/x en agent/fix-1 (estado: ready)\n"]);
    expect(err).toEqual([]);
  });

  it("sends the prompt when one is given", async () => {
    const { ctx, requests } = harness(historyHandler([historyEntry()]));
    await resumeSession(ctx, resumeCommand({ prompt: "sigue" }));
    expect(requests.find((request) => request.method === "POST")?.body).toBe('{"prompt":"sigue"}');
  });

  it("resolves a unique prefix of the id from the history", async () => {
    const { ctx, requests, out } = harness(
      historyHandler([historyEntry(), historyEntry({ id: OTHER_ID })]),
    );
    expect(await resumeSession(ctx, resumeCommand({ id: "3f2a" }))).not.toBeNull();
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(requests[1]?.url).toBe(`http://edge.test/session/history/${SESSION_ID}/resume`);
    expect(out).toHaveLength(1);
  });

  it("refuses an ambiguous prefix without resuming anything", async () => {
    const { ctx, requests, out, err } = harness(
      historyHandler([
        historyEntry(),
        historyEntry({ id: "3f2a0000-1111-4222-8333-444455556666" }),
      ]),
    );
    expect(await resumeSession(ctx, resumeCommand({ id: "3f2a" }))).toBeNull();
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    expect(out).toEqual([]);
    expect(err).toEqual(["cna: El id es ambiguo: escribe más caracteres\n"]);
  });

  it("refuses a prefix that matches no session", async () => {
    const { ctx, requests, err } = harness(historyHandler([historyEntry()]));
    expect(await resumeSession(ctx, resumeCommand({ id: "ffff" }))).toBeNull();
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    expect(err).toEqual(["cna: No existe esa sesión en el historial\n"]);
  });

  it("explains history_not_found", async () => {
    const { ctx, err } = harness(() =>
      json({ error: "history_not_found", message: "no encontrada" }, 404),
    );
    expect(await resumeSession(ctx, resumeCommand())).toBeNull();
    expect(err).toEqual(["cna: No existe esa sesión en el historial\n"]);
  });

  it("explains session_exists when the replica is busy", async () => {
    const { ctx, out, err } = harness(() => json({ error: "session_exists" }, 409));
    expect(await resumeSession(ctx, resumeCommand())).toBeNull();
    expect(out).toEqual([]);
    expect(err).toEqual([
      "cna: Ya hay una sesión en esta réplica (mira cna status o ciérrala con cna close)\n",
    ]);
  });
});

const REPLICA_SESSION: SessionInfo = sessionInfo({ status: "ready", repo: "owner/x" });

function replicaSummary(overrides: Partial<ReplicaSummary> = {}): ReplicaSummary {
  return { name: "agent-1", reachable: true, session: null, ...overrides };
}

describe("formatReplicas", () => {
  it("marks the first replica as the default and prints the four states", () => {
    const text = formatReplicas(
      [
        replicaSummary({ name: "agent-1", session: REPLICA_SESSION }),
        replicaSummary({ name: "agent-2", reachable: false }),
        replicaSummary({ name: "agent-3", session: null }),
        replicaSummary({
          name: "agent-4",
          session: sessionInfo({ status: "running", repo: "octo/hello", branch: null }),
        }),
      ],
      false,
    );
    expect(text).toBe(
      [
        "agent-1 (por defecto) — ready · owner/x · agent/fix-1",
        "agent-2 — no responde",
        "agent-3 — libre",
        "agent-4 — running · octo/hello",
        "",
      ].join("\n"),
    );
  });

  it("does not mark a later replica as the default", () => {
    expect(
      formatReplicas(
        [replicaSummary({ name: "agent-1" }), replicaSummary({ name: "agent-2" })],
        false,
      ),
    ).toBe("agent-1 (por defecto) — libre\nagent-2 — libre\n");
  });

  it("prints no ANSI codes without color and paints the name and the red state with color", () => {
    const replicas = [
      replicaSummary({ name: "agent-1", session: REPLICA_SESSION }),
      replicaSummary({ name: "agent-2", reachable: false }),
    ];
    expect(formatReplicas(replicas, false)).not.toContain(ESC);
    const colored = formatReplicas(replicas, true);
    expect(colored).toContain(`${ESC}[1magent-1${ESC}[0m (por defecto) — `);
    expect(colored).toContain(`${ESC}[31mno responde${ESC}[0m`);
  });

  it("sanitizes the name, status, repo and branch from the server", () => {
    const text = formatReplicas(
      [
        replicaSummary({
          name: "\u001b[31mx",
          session: sessionInfo({
            status: "\u001b[2Jready" as SessionInfo["status"],
            repo: "owner/\u001b[31m",
            branch: "agent/\r\nevil",
          }),
        }),
      ],
      false,
    );
    expect(text).not.toContain(ESC);
    expect(text).toContain("\uFFFD[31mx (por defecto)");
    expect(text).toContain("\uFFFD[2Jready · owner/\uFFFD[31m · agent/\nevil\n");
  });

  it("says there are no replicas when the list is empty", () => {
    expect(formatReplicas([], false)).toBe("No hay réplicas\n");
  });
});

describe("runReplicas", () => {
  it("prints GET /replicas and returns 0", async () => {
    const { ctx, requests, out, err } = harness(() =>
      json({ replicas: [replicaSummary({ name: "agent-1", session: null })] }),
    );
    expect(await runReplicas(ctx)).toBe(0);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "http://edge.test/replicas",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(out.join("")).toBe("agent-1 (por defecto) — libre\n");
    expect(err).toEqual([]);
  });

  it("writes the fixed token message to stderr and returns 1 on 401", async () => {
    const { ctx, out, err } = harness(() =>
      json({ error: "unauthorized", message: "sk-secret" }, 401),
    );
    expect(await runReplicas(ctx)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "cna: Token no válido o ausente: define CNA_TOKEN con el AGENT_API_TOKEN de edge\n",
    ]);
    expect(err.join("")).not.toContain("sk-secret");
  });
});
