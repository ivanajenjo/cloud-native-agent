import { describe, expect, it } from "vitest";
import { createJsonlDecoder, encodeJsonl, type JsonlParseError } from "../src/rpc/jsonl.js";

function setup() {
  const records: unknown[] = [];
  const errors: JsonlParseError[] = [];
  const decoder = createJsonlDecoder(
    (value) => records.push(value),
    (error) => errors.push(error),
  );
  return { records, errors, decoder };
}

describe("createJsonlDecoder", () => {
  it("delivers a simple record", () => {
    const { records, errors, decoder } = setup();

    decoder.push('{"type":"a"}\n');

    expect(records).toEqual([{ type: "a" }]);
    expect(errors).toEqual([]);
  });

  it("delivers several records found in one chunk", () => {
    const { records, decoder } = setup();

    decoder.push('{"n":1}\n{"n":2}\n[3]\n');

    expect(records).toEqual([{ n: 1 }, { n: 2 }, [3]]);
  });

  it("reassembles a record split across three chunks, inside a key and inside a string", () => {
    const { records, decoder } = setup();

    decoder.push('{"ty');
    decoder.push('pe":"hello wo');
    decoder.push('rld"}\n');

    expect(records).toEqual([{ type: "hello world" }]);
  });

  it("treats \\r\\n as a line ending and keeps escaped \\r inside strings", () => {
    const { records, errors, decoder } = setup();

    decoder.push('{"a":"x\\ry"}\r\n{"b":2}\r\n');

    expect(errors).toEqual([]);
    expect(records).toEqual([{ a: "x\ry" }, { b: 2 }]);
  });

  it("does not split on literal U+2028 and U+2029 inside JSON strings", () => {
    const { records, errors, decoder } = setup();
    const text = "line one two";

    decoder.push(`${JSON.stringify({ text })}\n`);
    decoder.end();

    expect(errors).toEqual([]);
    expect(records).toEqual([{ text }]);
    expect((records[0] as { text: string }).text).toBe(text);
  });

  it("decodes multi-byte UTF-8 characters split across Buffer chunks", () => {
    const { records, errors, decoder } = setup();
    const bytes = Buffer.from('{"price":"€","face":"😀"}\n', "utf8");

    // "€" is E2 82 AC; "😀" is F0 9F 98 80. Cut inside both sequences.
    const euroStart = bytes.indexOf(Buffer.from("€"));
    const faceStart = bytes.indexOf(Buffer.from("😀"));
    decoder.push(bytes.subarray(0, euroStart + 1));
    decoder.push(bytes.subarray(euroStart + 1, faceStart + 2));
    decoder.push(bytes.subarray(faceStart + 2));

    expect(errors).toEqual([]);
    expect(records).toEqual([{ price: "€", face: "😀" }]);
  });

  it("ignores empty and whitespace-only lines", () => {
    const { records, errors, decoder } = setup();

    decoder.push('\n   \n\t\r\n{"ok":true}\n  \n');

    expect(errors).toEqual([]);
    expect(records).toEqual([{ ok: true }]);
  });

  it("reports invalid JSON and keeps decoding the next valid record", () => {
    const { records, errors, decoder } = setup();

    decoder.push('{"broken":\n{"ok":1}\n');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe('{"broken":');
    expect(typeof errors[0]?.message).toBe("string");
    expect(errors[0]?.message.length).toBeGreaterThan(0);
    expect(records).toEqual([{ ok: 1 }]);
  });

  it("truncates the offending line to 200 characters", () => {
    const { errors, decoder } = setup();
    const longLine = "x".repeat(500);

    decoder.push(`${longLine}\n`);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.line.length).toBe(200);
    expect(errors[0]?.line).toBe("x".repeat(200));
  });

  it("delivers a last record without a trailing newline on end()", () => {
    const { records, decoder } = setup();

    decoder.push('{"a":1}\n{"b":2}');
    decoder.end();

    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("does nothing on end() when the buffer is empty", () => {
    const { records, errors, decoder } = setup();

    decoder.push('{"a":1}\n');
    decoder.end();

    expect(records).toEqual([{ a: 1 }]);
    expect(errors).toEqual([]);
  });

  it("does nothing on end() when only whitespace remains", () => {
    const { records, errors, decoder } = setup();

    decoder.push('{"a":1}\n   ');
    decoder.end();

    expect(records).toEqual([{ a: 1 }]);
    expect(errors).toEqual([]);
  });

  it("throws when push is called after end()", () => {
    const { decoder } = setup();

    decoder.end();

    expect(() => decoder.push('{"a":1}\n')).toThrow(Error);
    expect(() => decoder.push('{"a":1}\n')).toThrow("decoder ended");
  });
});

describe("encodeJsonl", () => {
  it("appends a single LF and never emits a literal LF inside the record", () => {
    const encoded = encodeJsonl({ a: "x\ny" });

    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.indexOf("\n")).toBe(encoded.length - 1);
    expect(encoded).toBe('{"a":"x\\ny"}\n');
  });
});
