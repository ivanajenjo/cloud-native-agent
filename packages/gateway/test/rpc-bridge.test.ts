import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiLaunchSpec } from "../src/pi/launch.js";
import {
  RpcBridge,
  type RpcBridgeHandlers,
  type RpcBridgeOptions,
  RpcCommandError,
  type RpcEvent,
  type RpcExit,
} from "../src/rpc/bridge.js";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

interface Recorder {
  events: RpcEvent[];
  uiRequests: RpcExtensionUIRequest[];
  exits: RpcExit[];
  stderr: string[];
  protocolErrors: string[];
}

let tmp: string;
let bridges: RpcBridge[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rpc-bridge-"));
  bridges = [];
});

afterEach(async () => {
  await Promise.all(bridges.map((bridge) => bridge.stop()));
  rmSync(tmp, { recursive: true, force: true });
});

function launchSpec(env: Record<string, string> = {}): PiLaunchSpec {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  return {
    command: process.execPath,
    args: [FAKE_PI],
    cwd: process.cwd(),
    env: { ...base, ...env },
  };
}

function createRecorder(): { recorder: Recorder; handlers: RpcBridgeHandlers } {
  const recorder: Recorder = {
    events: [],
    uiRequests: [],
    exits: [],
    stderr: [],
    protocolErrors: [],
  };
  const handlers: RpcBridgeHandlers = {
    onEvent: (event) => {
      recorder.events.push(event);
    },
    onUiRequest: (request) => {
      recorder.uiRequests.push(request);
    },
    onExit: (exit) => {
      recorder.exits.push(exit);
    },
    onStderr: (line) => {
      recorder.stderr.push(line);
    },
    onProtocolError: (message) => {
      recorder.protocolErrors.push(message);
    },
  };
  return { recorder, handlers };
}

function track(bridge: RpcBridge): RpcBridge {
  bridges.push(bridge);
  return bridge;
}

function open(
  env: Record<string, string> = {},
  options: RpcBridgeOptions = {},
): { bridge: RpcBridge; recorder: Recorder } {
  const { recorder, handlers } = createRecorder();
  const bridge = track(
    RpcBridge.start(launchSpec(env), handlers, { stopTimeoutMs: 200, ...options }),
  );
  return { bridge, recorder };
}

function eventTypes(recorder: Recorder): string[] {
  return recorder.events.map((event) => event.type);
}

async function rejectionOf(promise: Promise<unknown>): Promise<RpcCommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcCommandError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the promise to reject");
}

describe("RpcBridge", () => {
  it("resolves commands with their data and uses sequential cna ids", async () => {
    const commandLog = join(tmp, "commands.jsonl");
    const { bridge } = open({ FAKE_PI_LOG: commandLog });

    await expect(bridge.send({ type: "get_state" })).resolves.toEqual({ isStreaming: false });
    await expect(bridge.send({ type: "get_state" })).resolves.toEqual({ isStreaming: false });

    const ids = readFileSync(commandLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).id);
    expect(ids).toEqual(["cna-1", "cna-2"]);
  });

  it("delivers a prompt's events in order, keeping U+2028 inside one event", async () => {
    const { bridge, recorder } = open();

    await expect(bridge.send({ type: "prompt", message: "hola" })).resolves.toEqual({
      disposition: "started",
    });
    await vi.waitFor(() => expect(eventTypes(recorder)).toContain("agent_settled"));

    expect(eventTypes(recorder)).toEqual([
      "agent_start",
      "message_update",
      "agent_end",
      "auto_retry_start",
      "agent_start",
      "agent_end",
      "agent_settled",
    ]);
    const update = recorder.events[1];
    expect(update).toMatchObject({
      assistantMessageEvent: { type: "text_delta", delta: "hola mundo" },
    });
    expect(recorder.events[2]).toMatchObject({ willRetry: true });
    expect(recorder.events[5]).toMatchObject({ willRetry: false });
    expect(recorder.exits).toEqual([]);
  });

  it("answers two pending extension dialogs in any order", async () => {
    const { bridge, recorder } = open();

    await bridge.send({ type: "prompt", message: "ask" });
    await vi.waitFor(() => expect(recorder.uiRequests).toHaveLength(2));

    expect(recorder.uiRequests[0]).toMatchObject({
      id: "ui-1",
      method: "select",
      options: ["a", "b"],
    });
    expect(recorder.uiRequests[1]).toMatchObject({ id: "ui-2", method: "confirm" });

    bridge.respondUi({ type: "extension_ui_response", id: "ui-2", confirmed: true });
    bridge.respondUi({ type: "extension_ui_response", id: "ui-1", value: "b" });
    await vi.waitFor(() => expect(eventTypes(recorder)).toContain("agent_settled"));

    const answers = recorder.events.find((event) => event.type === "test_ui_answers");
    expect(answers).toEqual({
      type: "test_ui_answers",
      answers: [
        { type: "extension_ui_response", id: "ui-2", confirmed: true },
        { type: "extension_ui_response", id: "ui-1", value: "b" },
      ],
    });
  });

  it("reassembles a record split across writes and terminated by CRLF", async () => {
    const { bridge, recorder } = open();

    await bridge.send({ type: "prompt", message: "split" });
    await vi.waitFor(() => expect(eventTypes(recorder)).toContain("split_event"));

    expect(recorder.events).toEqual([{ type: "split_event", text: "uno dos" }]);
    expect(recorder.protocolErrors).toEqual([]);
  });

  it("reports an invalid line as protocol error, keeps reading, and forwards stderr", async () => {
    const { bridge, recorder } = open();

    await bridge.send({ type: "prompt", message: "noise" });
    await vi.waitFor(() => {
      expect(eventTypes(recorder)).toContain("after_noise");
      expect(recorder.stderr).toContain("fake-pi: diagnostic line");
    });

    expect(recorder.protocolErrors).toHaveLength(1);
    expect(recorder.protocolErrors[0]).not.toContain("{not json");
  });

  it("rejects with reason failed when Pi answers success:false", async () => {
    const { bridge } = open();

    const error = await rejectionOf(
      bridge.send({ type: "set_model", provider: "x", modelId: "y" }),
    );

    expect(error).toBeInstanceOf(RpcCommandError);
    expect(error.reason).toBe("failed");
    expect(error.command).toBe("set_model");
    expect(error.message).toContain("Model not found");
  });

  it("rejects with reason timeout and removes the pending entry", async () => {
    const { bridge, recorder } = open();

    const error = await rejectionOf(bridge.send({ type: "get_messages" }, { timeoutMs: 100 }));

    expect(error.reason).toBe("timeout");
    expect(error.command).toBe("get_messages");
    expect(bridge.running).toBe(true);
    expect(recorder.exits).toEqual([]);
  });

  it("rejects pending commands with reason exited when the process dies", async () => {
    const { bridge, recorder } = open();

    const pending = rejectionOf(bridge.send({ type: "bash", command: "exit" }));
    const error = await pending;

    expect(error.reason).toBe("exited");
    await vi.waitFor(() => expect(recorder.exits).toHaveLength(1));
    expect(recorder.exits[0]).toEqual({ code: 3, signal: null, expected: false });
    expect(bridge.running).toBe(false);

    const later = await rejectionOf(bridge.send({ type: "get_state" }));
    expect(later.reason).toBe("not_running");
  });

  it("stops in order when stdin is closed", async () => {
    const { bridge, recorder } = open();

    await bridge.stop();

    expect(recorder.exits).toEqual([{ code: 0, signal: null, expected: true }]);
    expect(bridge.running).toBe(false);
  });

  it("escalates to SIGTERM when Pi ignores stdin EOF", async () => {
    const { bridge, recorder } = open({ FAKE_PI_IGNORE_EOF: "1" });

    await bridge.stop();

    expect(recorder.exits).toEqual([{ code: null, signal: "SIGTERM", expected: true }]);
  });

  it("escalates to SIGKILL when Pi ignores EOF and SIGTERM", async () => {
    const { bridge, recorder } = open({ FAKE_PI_IGNORE_EOF: "1", FAKE_PI_IGNORE_TERM: "1" });

    await bridge.stop();

    expect(recorder.exits).toEqual([{ code: null, signal: "SIGKILL", expected: true }]);
  });

  it("stop() can be called several times", async () => {
    const { bridge, recorder } = open();

    await Promise.all([bridge.stop(), bridge.stop()]);
    await bridge.stop();

    expect(recorder.exits).toHaveLength(1);
  });

  it("reports a missing executable once, with expected false", async () => {
    const { recorder, handlers } = createRecorder();
    const spec: PiLaunchSpec = { ...launchSpec(), command: "/nonexistent/pi", args: [] };
    const bridge = track(RpcBridge.start(spec, handlers, { stopTimeoutMs: 200 }));

    const error = await rejectionOf(bridge.send({ type: "get_state" }));

    expect(error.reason).toBe("exited");
    await vi.waitFor(() => expect(recorder.exits).toHaveLength(1));
    expect(recorder.exits).toEqual([{ code: null, signal: null, expected: false }]);
    expect(bridge.running).toBe(false);
    await expect(bridge.send({ type: "get_state" })).rejects.toBeInstanceOf(RpcCommandError);

    await bridge.stop();
    expect(recorder.exits).toHaveLength(1);
  });

  it("keeps delivering events after an onEvent handler throws", async () => {
    const { recorder, handlers } = createRecorder();
    let thrown = false;
    const bridge = track(
      RpcBridge.start(
        launchSpec(),
        {
          ...handlers,
          onEvent: (event) => {
            recorder.events.push(event);
            if (event.type === "agent_start" && !thrown) {
              thrown = true;
              throw new Error("handler failure");
            }
          },
        },
        { stopTimeoutMs: 200 },
      ),
    );

    await bridge.send({ type: "prompt", message: "hola" });
    await vi.waitFor(() => expect(eventTypes(recorder)).toContain("agent_settled"));

    expect(eventTypes(recorder)).toEqual([
      "agent_start",
      "message_update",
      "agent_end",
      "auto_retry_start",
      "agent_start",
      "agent_end",
      "agent_settled",
    ]);
  });
});
