import type { Question } from "@cna/shared";
import { describe, expect, it } from "vitest";
import { formatQuestion, isMultiline, parseAnswer } from "../src/questions.js";

const BASE = { id: "q1", createdAt: "2026-11-17T10:00:00.000Z" };

function question(overrides: Partial<Question> & Pick<Question, "kind" | "method">): Question {
  return { ...BASE, title: "Título", ...overrides };
}

describe("formatQuestion", () => {
  it("shows the ask_user prompt with numbered options and the option labels", () => {
    const out = formatQuestion(
      question({ kind: "ask_user", method: "select", title: "¿Cuál?", options: ["a", "b"] }),
      false,
    );
    expect(out).toBe("? Pregunta:\n¿Cuál?\n  1) a\n  2) b\nElige un número (o /cancel):\n");
  });

  it("uses the Spanish labels of plan options", () => {
    const out = formatQuestion(
      question({
        kind: "plan",
        method: "select",
        title: "Plan:\n1. hacer X\n2. probar Y",
        options: ["approve", "request_changes"],
      }),
      false,
    );
    expect(out).toBe(
      "? Plan:\nPlan:\n1. hacer X\n2. probar Y\n  1) Aprobar\n  2) Pedir cambios\nElige un número (o /cancel):\n",
    );
  });

  it("shows the confirm prompt with the message", () => {
    const out = formatQuestion(
      question({
        kind: "confirm",
        method: "confirm",
        title: "Push",
        message: "Subir agent/x a origin",
      }),
      false,
    );
    expect(out).toBe(
      "? Confirmación:\nPush\nSubir agent/x a origin\n¿Confirmas? [s/n] (o /cancel):\n",
    );
  });

  it("shows the input prompt with and without placeholder", () => {
    expect(
      formatQuestion(question({ kind: "ask_user", method: "input", title: "Nombre" }), false),
    ).toBe("? Pregunta:\nNombre\nRespuesta (o /cancel):\n");
    expect(
      formatQuestion(
        question({ kind: "ask_user", method: "input", title: "Nombre", placeholder: "ej. Ana" }),
        false,
      ),
    ).toBe("? Pregunta:\nNombre\nRespuesta (o /cancel): [ej. Ana]\n");
  });

  it("shows the editor prompt and the prefill", () => {
    expect(
      formatQuestion(question({ kind: "ask_user", method: "editor", title: "Texto" }), false),
    ).toBe(
      '? Pregunta:\nTexto\nEscribe la respuesta; termina con una línea que solo tenga "." (o /cancel):\n',
    );
    expect(
      formatQuestion(
        question({ kind: "ask_user", method: "editor", title: "Texto", prefill: "borrador" }),
        false,
      ),
    ).toBe(
      '? Pregunta:\nTexto\nTexto inicial:\nborrador\nEscribe la respuesta; termina con una línea que solo tenga "." (o /cancel):\n',
    );
  });

  it("shows the network host and port", () => {
    const out = formatQuestion(
      question({
        kind: "network",
        method: "select",
        title: "Acceso",
        options: ["allow_once", "allow_always", "deny"],
        network: { host: "api.example.com", port: 443 },
      }),
      false,
    );
    expect(out).toBe(
      "? Red: api.example.com:443:\nAcceso\n  1) Permitir esta vez\n  2) Permitir siempre\n  3) Denegar\nElige un número (o /cancel):\n",
    );
  });

  it("falls back to 'Red' without network data", () => {
    expect(
      formatQuestion(
        question({ kind: "network", method: "select", options: ["deny"], title: "t" }),
        false,
      ).startsWith("? Red:\n"),
    ).toBe(true);
  });

  it("shows the timeout rounded up to seconds", () => {
    expect(
      formatQuestion(
        question({ kind: "confirm", method: "confirm", title: "t", timeoutMs: 90_500 }),
        false,
      ),
    ).toBe("? Confirmación:\nt\n(caduca en 91 s)\n¿Confirmas? [s/n] (o /cancel):\n");
  });

  it("sanitizes the untrusted texts", () => {
    const out = formatQuestion(
      question({ kind: "ask_user", method: "select", title: "\x1b[2Jhola", options: ["\x07x"] }),
      false,
    );
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).toContain("\uFFFD[2Jhola");
  });

  it("adds the color only when enabled", () => {
    const plain = formatQuestion(question({ kind: "confirm", method: "confirm" }), false);
    const colored = formatQuestion(question({ kind: "confirm", method: "confirm" }), true);
    expect(plain).not.toContain("\x1b");
    expect(colored.startsWith("\x1b[1;33m? Confirmación:\x1b[0m\n")).toBe(true);
  });
});

describe("parseAnswer", () => {
  const select = question({ kind: "ask_user", method: "select", options: ["a", "b", "c"] });
  const confirm = question({ kind: "confirm", method: "confirm" });
  const input = question({ kind: "ask_user", method: "input" });
  const editor = question({ kind: "ask_user", method: "editor" });

  describe("/cancel", () => {
    it.each([[select], [confirm], [input], [editor]])("cancels any method (%#)", (q) => {
      expect(parseAnswer(q, "/cancel")).toEqual({ ok: true, answer: { cancelled: true } });
      expect(parseAnswer(q, "  /cancel  ")).toEqual({ ok: true, answer: { cancelled: true } });
    });
  });

  describe("select", () => {
    it("takes a number of the list", () => {
      expect(parseAnswer(select, "1")).toEqual({ ok: true, answer: { value: "a" } });
      expect(parseAnswer(select, "3")).toEqual({ ok: true, answer: { value: "c" } });
    });

    it("accepts spaces around the number", () => {
      expect(parseAnswer(select, " 2 ")).toEqual({ ok: true, answer: { value: "b" } });
    });

    it("rejects numbers out of range", () => {
      const expected = { ok: false, error: "Opción no válida: elige un número del 1 al 3" };
      expect(parseAnswer(select, "0")).toEqual(expected);
      expect(parseAnswer(select, "4")).toEqual(expected);
    });

    it("rejects text that is not a number", () => {
      expect(parseAnswer(select, "abc")).toEqual({
        ok: false,
        error: "Opción no válida: elige un número del 1 al 3",
      });
    });

    it("accepts the exact value of an option", () => {
      const plan = question({
        kind: "network",
        method: "select",
        options: ["allow_once", "allow_always", "deny"],
      });
      expect(parseAnswer(plan, "allow_always")).toEqual({
        ok: true,
        answer: { value: "allow_always" },
      });
      expect(parseAnswer(plan, " deny ")).toEqual({ ok: true, answer: { value: "deny" } });
    });

    it("fails without options", () => {
      const empty = question({ kind: "ask_user", method: "select" });
      const result = parseAnswer(empty, "1");
      expect(result.ok).toBe(false);
    });
  });

  describe("confirm", () => {
    it.each(["s", "si", "sí", "y", "yes", "SÍ", " S "])("accepts %j as yes", (text) => {
      expect(parseAnswer(confirm, text)).toEqual({ ok: true, answer: { confirmed: true } });
    });

    it.each(["n", "no", "NO", " n "])("accepts %j as no", (text) => {
      expect(parseAnswer(confirm, text)).toEqual({ ok: true, answer: { confirmed: false } });
    });

    it("rejects other answers", () => {
      expect(parseAnswer(confirm, "quizá")).toEqual({ ok: false, error: "Responde s o n" });
      expect(parseAnswer(confirm, "")).toEqual({ ok: false, error: "Responde s o n" });
    });
  });

  describe("input", () => {
    it("keeps the text as typed", () => {
      expect(parseAnswer(input, "  hola  ")).toEqual({ ok: true, answer: { value: "  hola  " } });
    });

    it("removes one final line break", () => {
      expect(parseAnswer(input, "hola\n")).toEqual({ ok: true, answer: { value: "hola" } });
      expect(parseAnswer(input, "hola\r\n")).toEqual({ ok: true, answer: { value: "hola" } });
    });
  });

  describe("editor", () => {
    it("keeps the joined text as it is", () => {
      expect(parseAnswer(editor, "línea 1\n\nlínea 2 ")).toEqual({
        ok: true,
        answer: { value: "línea 1\n\nlínea 2 " },
      });
    });
  });
});

describe("isMultiline", () => {
  it("is true only for editor questions", () => {
    expect(isMultiline(question({ kind: "ask_user", method: "editor" }))).toBe(true);
    expect(isMultiline(question({ kind: "ask_user", method: "input" }))).toBe(false);
    expect(isMultiline(question({ kind: "confirm", method: "confirm" }))).toBe(false);
    expect(isMultiline(question({ kind: "plan", method: "select" }))).toBe(false);
  });
});
