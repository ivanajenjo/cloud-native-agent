import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED, secretsFromEnv } from "../src/redact.js";

const TOKEN = "ghp_abcdef123456";

describe("redactString", () => {
  it("replaces every occurrence of a secret", () => {
    const r = createRedactor([TOKEN]);

    expect(r.redactString(`a ${TOKEN} b ${TOKEN} c ${TOKEN}`)).toBe(
      `a ${REDACTED} b ${REDACTED} c ${REDACTED}`,
    );
  });

  it("also replaces the URL-encoded form of a secret", () => {
    const secret = "abc/def+ghi=jkl";
    const r = createRedactor([secret]);

    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toBe(secret);
    expect(r.redactString(`https://host/?token=${encoded}&x=1`)).toBe(
      `https://host/?token=${REDACTED}&x=1`,
    );
    expect(r.redactString(`raw ${secret}`)).toBe(`raw ${REDACTED}`);
  });

  it("treats regex special characters literally", () => {
    const secret = "a.b*c+d?e(f)";
    const r = createRedactor([secret]);

    expect(r.redactString(`key=${secret}`)).toBe(`key=${REDACTED}`);
    expect(r.redactString("axbbbc")).toBe("axbbbc");
  });

  it("ignores secrets shorter than minLength (default 8)", () => {
    const r = createRedactor(["short12"]);

    expect(r.redactString("short12 here")).toBe("short12 here");
  });

  it("honours a configurable minLength", () => {
    const r = createRedactor(["short12"], { minLength: 4 });

    expect(r.redactString("short12 here")).toBe(`${REDACTED} here`);
  });

  it("redacts a secret that contains another secret entirely", () => {
    const r = createRedactor(["sk-abcdefgh", "sk-abcdefgh-LONGER-part"]);

    expect(r.redactString("value sk-abcdefgh-LONGER-part end")).toBe(`value ${REDACTED} end`);
  });

  it("does not corrupt the placeholder when a shorter secret matches inside it", () => {
    // "ACT" occurs inside the placeholder; it must not be replaced there.
    const r = createRedactor(["RED-SECRET", "ACT"], { minLength: 3 });

    expect(r.redactString("x RED-SECRET y")).toBe(`x ${REDACTED} y`);
  });

  it("returns the input unchanged when there are no secrets", () => {
    const r = createRedactor([undefined, "", "tiny"]);

    expect(r.redactString("nothing to hide")).toBe("nothing to hide");
    expect(r.redact({ a: "nothing to hide" })).toEqual({ a: "nothing to hide" });
  });

  it("accepts duplicates and undefined values", () => {
    const r = createRedactor([TOKEN, undefined, TOKEN]);

    expect(r.redactString(TOKEN)).toBe(REDACTED);
  });
});

describe("redact", () => {
  it("walks arrays, nested objects and keeps non-string scalars", () => {
    const r = createRedactor([TOKEN]);
    const input = {
      msg: `token ${TOKEN}`,
      count: 3,
      ok: true,
      nothing: null,
      missing: undefined,
      list: [TOKEN, { deep: { value: `x${TOKEN}` } }, 7],
    };

    const out = r.redact(input);

    expect(out).toEqual({
      msg: `token ${REDACTED}`,
      count: 3,
      ok: true,
      nothing: null,
      missing: undefined,
      list: [REDACTED, { deep: { value: `x${REDACTED}` } }, 7],
    });
  });

  it("does not redact object keys", () => {
    const r = createRedactor([TOKEN]);

    const out = r.redact({ [TOKEN]: TOKEN });

    expect(out).toEqual({ [TOKEN]: REDACTED });
  });

  it("never mutates the input", () => {
    const r = createRedactor([TOKEN]);
    const input = { msg: TOKEN, nested: { list: [TOKEN] } };

    const out = r.redact(input);

    expect(out).not.toBe(input);
    expect(input).toEqual({ msg: TOKEN, nested: { list: [TOKEN] } });
  });

  it("replaces cycles with [Circular] without looping forever", () => {
    const r = createRedactor([TOKEN]);
    const node: Record<string, unknown> = { name: TOKEN };
    node.self = node;
    const list: unknown[] = [TOKEN];
    list.push(list);

    const outNode = r.redact(node) as Record<string, unknown>;
    const outList = r.redact(list) as unknown[];

    expect(outNode).toEqual({ name: REDACTED, self: "[Circular]" });
    expect(outList).toEqual([REDACTED, "[Circular]"]);
    expect(node.self).toBe(node);
  });

  it("returns the value as is when there are no secrets", () => {
    const r = createRedactor([]);

    expect(r.redact({ a: [1, "two"] })).toEqual({ a: [1, "two"] });
    expect(r.redact("plain")).toBe("plain");
  });
});

describe("secretsFromEnv", () => {
  it("collects the known secret variables and the suffix-matched ones", () => {
    const env = {
      GITHUB_TOKEN: "gh-value-1",
      GH_TOKEN: "gh-value-2",
      AGENT_API_TOKEN: "agent-value",
      ANTHROPIC_API_KEY: "anthropic-value",
      FOO_SECRET: "foo-value",
      DB_PASSWORD: "db-value",
      X_TOKEN: "x-value",
    };

    expect(secretsFromEnv(env).sort()).toEqual(Object.values(env).sort());
  });

  it("ignores unrelated variables, empty values and undefined values", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/agent",
      TOKEN_COUNT: "42",
      GITHUB_TOKEN: "",
      FOO_SECRET: undefined,
      BAR_TOKEN: "kept-value",
    };

    expect(secretsFromEnv(env)).toEqual(["kept-value"]);
  });

  it("does not match lowercase names", () => {
    expect(secretsFromEnv({ foo_api_key: "lower-value" })).toEqual([]);
  });
});
