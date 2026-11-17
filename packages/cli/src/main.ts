#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ApiClient } from "@cna/shared/client";
import { type ParsedArgs, parseCliArgs, USAGE, UsageError } from "./args.js";
import { runChat } from "./chat.js";
import {
  type CommandContext,
  createSession,
  describeError,
  type Output,
  runAbort,
  runClose,
  runDiff,
  runStatus,
  runTodos,
} from "./commands.js";

const USAGE_HINT = "Usa «cna help» para ver la ayuda.";

const output: Output = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/**
 * Attaches the terminal to the session chat. Ctrl-C ends the chat only: the session keeps
 * running on the server.
 */
async function attachChat(ctx: CommandContext): Promise<number> {
  const abort = new AbortController();
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  const onSigint = (): void => {
    if (abort.signal.aborted) return;
    abort.abort();
    process.stdout.write("\n(desconectado; la sesión sigue en marcha)\n");
  };
  rl.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);
  try {
    return await runChat({
      client: ctx.client,
      output: ctx.output,
      color: ctx.color,
      input: rl,
      signal: abort.signal,
      lastEventId: 0,
    });
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(process.argv.slice(2), process.env, process.stdout.isTTY === true);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    output.err(`cna: ${error.message}\n${USAGE_HINT}\n`);
    return 2;
  }

  const { command, options } = parsed;
  if (command.name === "help") {
    output.out(USAGE);
    return 0;
  }
  if (command.name === "version") {
    output.out(`${readVersion()}\n`);
    return 0;
  }

  const token = process.env.CNA_TOKEN;
  if (token === undefined || token === "") {
    output.err("cna: define CNA_TOKEN con el AGENT_API_TOKEN de edge\n");
    return 2;
  }
  const ctx: CommandContext = {
    client: new ApiClient({ baseUrl: options.url, token }),
    output,
    color: options.color,
  };

  switch (command.name) {
    case "run": {
      const info = await createSession(ctx, command);
      if (info === null) return 1;
      if (command.detach) return 0;
      return attachChat(ctx);
    }
    case "chat":
      return attachChat(ctx);
    case "status":
      return runStatus(ctx);
    case "diff":
      return runDiff(ctx, command);
    case "todos":
      return runTodos(ctx);
    case "abort":
      return runAbort(ctx);
    case "close":
      return runClose(ctx, command);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    output.err(`cna: ${describeError(error)}\n`);
    process.exit(1);
  },
);
