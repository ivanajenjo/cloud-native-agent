// Fake `pi --mode rpc` for the RpcBridge tests. Plain ESM, no dependencies.
// It speaks the same JSONL protocol on stdin/stdout; behaviour depends on the command and,
// for `prompt`, on the message. Environment switches:
//   FAKE_PI_IGNORE_EOF=1   do not exit when stdin is closed (to exercise SIGTERM)
//   FAKE_PI_IGNORE_TERM=1  ignore SIGTERM (to exercise SIGKILL)
//   FAKE_PI_LOG=<path>     append every received command line to this file (to check ids)
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const ignoreEof = process.env.FAKE_PI_IGNORE_EOF === "1";
const ignoreTerm = process.env.FAKE_PI_IGNORE_TERM === "1";
const logPath = process.env.FAKE_PI_LOG;

if (ignoreEof) {
  // Keeps the event loop alive after stdin is closed.
  setInterval(() => {}, 60_000);
}
if (ignoreTerm) {
  process.on("SIGTERM", () => {});
}

/** Pending answers of the "ask" scenario, in arrival order; null when no scenario is running. */
let askAnswers = null;

function write(record) {
  // JSON.stringify leaves U+2028/U+2029 raw inside strings, which is what the tests need.
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(command, data) {
  write({ id: command.id, type: "response", command: command.type, success: true, data });
}

function fail(command, error) {
  write({ id: command.id, type: "response", command: command.type, success: false, error });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeSplitEvent() {
  const line = Buffer.from(`${JSON.stringify({ type: "split_event", text: "uno dos" })}\r\n`);
  // Cut in the middle of the 3-byte U+2028 sequence, then near the end, to test byte-level framing.
  const separator = Buffer.from(" ");
  const middleOfSeparator = line.indexOf(separator) + 1;
  const nearEnd = line.length - 4;
  const parts = [
    line.subarray(0, middleOfSeparator),
    line.subarray(middleOfSeparator, nearEnd),
    line.subarray(nearEnd),
  ];
  for (const part of parts) {
    process.stdout.write(part);
    await delay(10);
  }
}

function handlePrompt(command) {
  respond(command, { disposition: "started" });
  switch (command.message) {
    case "ask":
      askAnswers = [];
      write({
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Pick one",
        options: ["a", "b"],
      });
      write({
        type: "extension_ui_request",
        id: "ui-2",
        method: "confirm",
        title: "Confirm?",
        message: "Proceed?",
      });
      return;
    case "split":
      writeSplitEvent();
      return;
    case "noise":
      process.stdout.write("{not json\n");
      write({ type: "after_noise" });
      process.stderr.write("fake-pi: diagnostic line\n");
      return;
    default:
      write({ type: "agent_start" });
      write({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hola mundo" },
      });
      write({ type: "agent_end", messages: [], willRetry: true });
      write({ type: "auto_retry_start", attempt: 1 });
      write({ type: "agent_start" });
      write({ type: "agent_end", messages: [], willRetry: false });
      write({ type: "agent_settled", aborted: false });
  }
}

function handleUiResponse(response) {
  if (askAnswers === null) {
    return;
  }
  askAnswers.push(response);
  if (askAnswers.length === 2) {
    write({ type: "test_ui_answers", answers: askAnswers });
    askAnswers = null;
    write({ type: "agent_settled", aborted: false });
  }
}

function handleCommand(command) {
  if (command.type === "extension_ui_response") {
    handleUiResponse(command);
    return;
  }
  switch (command.type) {
    case "get_state":
      respond(command, { isStreaming: false });
      return;
    case "prompt":
      handlePrompt(command);
      return;
    case "abort":
      write({ id: command.id, type: "response", command: "abort", success: true });
      return;
    case "set_model":
      fail(command, "Model not found: x/y");
      return;
    case "get_messages":
      // Never answers: used to test timeouts.
      return;
    case "bash":
      if (command.command === "exit") {
        process.exit(3);
      }
      fail(command, "fake Pi only runs the 'exit' bash command");
      return;
    default:
      fail(command, `Unknown command: ${command.type}`);
  }
}

function handleLine(line) {
  if (logPath !== undefined) {
    appendFileSync(logPath, `${line}\n`);
  }
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    write({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
    return;
  }
  handleCommand(command);
}

// Strict JSONL reading: split on "\n" only (readline would also split on U+2028/U+2029).
const decoder = new StringDecoder("utf8");
let buffer = "";

function drainLines() {
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") {
      handleLine(line);
    }
    newline = buffer.indexOf("\n");
  }
}

process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  drainLines();
});

process.stdin.on("end", () => {
  buffer += decoder.end();
  drainLines();
  if (ignoreEof) {
    return;
  }
  process.exit(0);
});
