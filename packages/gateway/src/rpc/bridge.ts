import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import type { PiLaunchSpec } from "../pi/launch.js";
import { createJsonlDecoder, encodeJsonl } from "./jsonl.js";

/** RpcCommand without `id` (the bridge assigns it). Distributive over the union. */
export type RpcCommandInput = RpcCommand extends infer C
  ? C extends RpcCommand
    ? Omit<C, "id">
    : never
  : never;

/** Any stdout record that is not a response nor an extension_ui_request (session events). */
export type RpcEvent = { type: string } & Record<string, unknown>;

export interface RpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when stop() was called before the exit. */
  expected: boolean;
}

export interface RpcBridgeHandlers {
  onEvent(event: RpcEvent): void;
  onUiRequest(request: RpcExtensionUIRequest): void;
  onExit(exit: RpcExit): void;
  /** One stderr line (split on "\n", "\r" stripped, max 2000 chars). Not protocol. */
  onStderr?(line: string): void;
  /** Unparseable stdout line, or a response with no matching pending id. */
  onProtocolError?(message: string): void;
}

export type RpcCommandErrorReason = "failed" | "timeout" | "exited" | "not_running";

export class RpcCommandError extends Error {
  /** Pi's `command` field, or the command type we sent. */
  readonly command: string;
  /** "failed" = Pi answered success:false; "timeout"; "exited" = process ended first; "not_running". */
  readonly reason: RpcCommandErrorReason;

  constructor(message: string, command: string, reason: RpcCommandErrorReason) {
    super(message);
    this.name = "RpcCommandError";
    this.command = command;
    this.reason = reason;
  }
}

export interface RpcBridgeOptions {
  /** Default per-command timeout. Default 30000 ms. */
  commandTimeoutMs?: number;
  /** stop(): wait this long after closing stdin before SIGTERM, then the same again before SIGKILL. Default 10000. */
  stopTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const MAX_STDERR_LINE_LENGTH = 2000;

interface PendingCommand {
  command: string;
  resolve(data: unknown): void;
  reject(error: RpcCommandError): void;
  timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Subprocess client for `pi --mode rpc` (ADR-0002). Commands are correlated by id, session events
 * and extension dialogs are forwarded to the handlers, and dialogs are answered with respondUi().
 *
 * Secrets invariant: neither stdin/stdout content nor the spawn environment is ever reported.
 */
export class RpcBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly handlers: RpcBridgeHandlers;
  private readonly commandTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pending = new Map<string, PendingCommand>();
  /** Chunks waiting for stdin drain; `null` means "close stdin". */
  private readonly writeQueue: Array<string | null> = [];
  private waitingDrain = false;
  private nextId = 0;
  private finished = false;
  private closing = false;
  private stopRequested = false;
  private stopPromise: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;
  private stopTimer: NodeJS.Timeout | undefined;
  private stderrLine = "";

  private constructor(spec: PiLaunchSpec, handlers: RpcBridgeHandlers, options: RpcBridgeOptions) {
    this.handlers = handlers;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: "pipe",
    });
    this.wireStreams();
  }

  /** Spawns spec.command with spec.args, cwd and env; stdio all "pipe". */
  static start(
    spec: PiLaunchSpec,
    handlers: RpcBridgeHandlers,
    options: RpcBridgeOptions = {},
  ): RpcBridge {
    return new RpcBridge(spec, handlers, options);
  }

  /**
   * Sends a command with a fresh id "cna-<n>" (n increments from 1) and resolves with the `data` of the
   * successful response (undefined if it has none). Rejects RpcCommandError on success:false (message = Pi's
   * `error`), on timeout (the pending entry is removed; a late response then goes to onProtocolError), or if
   * the process exits first (all pending commands are rejected with reason "exited").
   */
  send(command: RpcCommandInput, options: { timeoutMs?: number } = {}): Promise<unknown> {
    const type = command.type;
    if (!this.running) {
      return Promise.reject(
        new RpcCommandError(`${type}: Pi process is not running`, type, "not_running"),
      );
    }
    this.nextId += 1;
    const id = `cna-${this.nextId}`;
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcCommandError(`${type}: no response within ${timeoutMs} ms`, type, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { command: type, resolve, reject, timer });
      this.enqueue(encodeJsonl({ ...command, id }));
    });
  }

  /** Writes an extension_ui_response. No-op if not running. */
  respondUi(response: RpcExtensionUIResponse): void {
    if (!this.running) {
      return;
    }
    this.enqueue(encodeJsonl(response));
  }

  /** Orderly shutdown: close stdin, wait, SIGTERM, wait, SIGKILL. Resolves when the process has exited. Idempotent. */
  stop(): Promise<void> {
    if (this.stopPromise === undefined) {
      this.stopRequested = true;
      this.closing = true;
      this.stopPromise = new Promise<void>((resolve) => {
        this.resolveStop = resolve;
      });
      if (this.finished) {
        this.resolveStop?.();
      } else {
        this.enqueue(null);
        this.stopTimer = setTimeout(() => this.escalate("SIGTERM"), this.stopTimeoutMs);
      }
    }
    return this.stopPromise;
  }

  /** True until the process has exited or stop() has been called. */
  get running(): boolean {
    return !this.finished && !this.closing;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private wireStreams(): void {
    // Strict JSONL: records are split only on "\n" (see jsonl.ts), never with readline.
    const stdoutDecoder = createJsonlDecoder(
      (value) => this.handleRecord(value),
      () => this.protocolError("unparseable stdout line"),
    );
    this.child.stdout.on("data", (chunk: Buffer) => stdoutDecoder.push(chunk));
    this.child.stdout.on("end", () => stdoutDecoder.end());

    const stderrDecoder = new StringDecoder("utf8");
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(stderrDecoder.write(chunk)));
    this.child.stderr.on("end", () => {
      this.onStderr(stderrDecoder.end());
      if (this.stderrLine !== "") {
        this.emitStderrLine();
      }
    });

    // Write errors (EPIPE after the process dies) surface through the exit path, not here.
    this.child.stdin.on("error", () => undefined);

    // A spawn failure (e.g. ENOENT) has no pid; the process never ran. Other errors are ignored
    // here because the exit event still arrives.
    this.child.on("error", () => {
      if (this.child.pid === undefined) {
        this.finish(null, null);
      }
    });
    // "close" (not "exit") so that all stdout has been delivered before pending commands are rejected.
    this.child.on("close", (code, signal) => this.finish(code, signal));
  }

  private handleRecord(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") {
      this.protocolError("record without a string type");
      return;
    }
    if (value.type === "response") {
      this.handleResponse(value);
      return;
    }
    if (value.type === "extension_ui_request") {
      const request = value as RpcExtensionUIRequest;
      this.invoke(() => this.handlers.onUiRequest(request));
      return;
    }
    const event = value as RpcEvent;
    this.invoke(() => this.handlers.onEvent(event));
  }

  private handleResponse(response: Record<string, unknown>): void {
    const id = response.id;
    const pending = typeof id === "string" ? this.pending.get(id) : undefined;
    if (typeof id !== "string" || pending === undefined) {
      this.protocolError("response without a pending id");
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.success === true) {
      pending.resolve(response.data);
      return;
    }
    const command = typeof response.command === "string" ? response.command : pending.command;
    const message = typeof response.error === "string" ? response.error : "command failed";
    pending.reject(new RpcCommandError(message, command, "failed"));
  }

  private onStderr(text: string): void {
    let rest = text;
    let newline = rest.indexOf("\n");
    while (newline !== -1) {
      this.appendStderr(rest.slice(0, newline));
      this.emitStderrLine();
      rest = rest.slice(newline + 1);
      newline = rest.indexOf("\n");
    }
    this.appendStderr(rest);
  }

  private appendStderr(part: string): void {
    const room = MAX_STDERR_LINE_LENGTH - this.stderrLine.length;
    if (room > 0) {
      this.stderrLine += part.slice(0, room);
    }
  }

  private emitStderrLine(): void {
    const raw = this.stderrLine;
    this.stderrLine = "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    this.invoke(() => this.handlers.onStderr?.(line));
  }

  private protocolError(message: string): void {
    this.invoke(() => this.handlers.onProtocolError?.(message));
  }

  /** Runs a handler callback; a throwing handler must not stop the stdout reader. */
  private invoke(callback: () => void): void {
    try {
      callback();
    } catch {
      // Deliberately ignored, and not logged: the error may carry protocol content.
    }
  }

  private enqueue(chunk: string | null): void {
    this.writeQueue.push(chunk);
    if (!this.waitingDrain) {
      this.flush();
    }
  }

  /** Writes queued chunks in order, waiting for "drain" whenever stdin reports backpressure. */
  private flush(): void {
    while (this.writeQueue.length > 0 && !this.waitingDrain) {
      const chunk = this.writeQueue.shift();
      if (chunk === null) {
        this.child.stdin.end();
      } else if (chunk !== undefined && !this.child.stdin.write(chunk)) {
        this.waitingDrain = true;
        this.child.stdin.once("drain", () => {
          this.waitingDrain = false;
          this.flush();
        });
      }
    }
  }

  private escalate(signal: "SIGTERM" | "SIGKILL"): void {
    if (this.finished) {
      return;
    }
    this.child.kill(signal);
    if (signal === "SIGTERM") {
      this.stopTimer = setTimeout(() => this.escalate("SIGKILL"), this.stopTimeoutMs);
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.writeQueue.length = 0;
    if (this.stopTimer !== undefined) {
      clearTimeout(this.stopTimer);
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new RpcCommandError(`${entry.command}: Pi process exited`, entry.command, "exited"),
      );
    }
    this.pending.clear();
    const expected = this.stopRequested;
    this.invoke(() => this.handlers.onExit({ code, signal, expected }));
    this.resolveStop?.();
  }
}
