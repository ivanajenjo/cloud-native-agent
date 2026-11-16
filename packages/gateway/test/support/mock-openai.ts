import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer of the model: either plain text or a list of tool calls. */
export type ScriptedTurn =
  | { text: string }
  | { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> };

export interface MockOpenAI {
  /** "http://127.0.0.1:<port>/v1" */
  url: string;
  /** Parsed JSON bodies received on /v1/chat/completions, in order. */
  requests: unknown[];
  close(): Promise<void>;
}

/** Answer given once the script is exhausted. */
const FINISHED_TEXT = "(script finished)";

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";

/**
 * Local OpenAI-compatible server for e2e tests. Each POST /v1/chat/completions consumes the next
 * turn of `script` (SSE streaming when the body asks for it, a plain JSON completion otherwise).
 * Never calls a real LLM. Listens on 127.0.0.1 with an ephemeral port.
 */
export function startMockOpenAI(model: string, script: ScriptedTurn[]): Promise<MockOpenAI> {
  const requests: unknown[] = [];
  const turns = [...script];
  let nextCallNumber = 0;

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "mock error");
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === MODELS_PATH) {
      sendJson(res, {
        object: "list",
        data: [{ id: model, object: "model", created: 0, owned_by: "mock" }],
      });
      return;
    }
    if (req.method !== "POST" || req.url !== CHAT_PATH) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const body = JSON.parse(await readBody(req)) as { stream?: boolean };
    requests.push(body);
    const turn: ScriptedTurn = turns.shift() ?? { text: FINISHED_TEXT };
    const created = Math.floor(Date.now() / 1000);

    if (body.stream === true) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      for (const chunk of streamChunks(turn, model, created, () => ++nextCallNumber)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    sendJson(
      res,
      completion(turn, model, created, () => ++nextCallNumber),
    );
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.closeAllConnections();
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

function usage() {
  return { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
}

/** The SSE chunks of one turn, in order, without the [DONE] marker. */
function streamChunks(
  turn: ScriptedTurn,
  model: string,
  created: number,
  nextCallNumber: () => number,
): unknown[] {
  const base = { id: `chatcmpl-mock-${created}`, object: "chat.completion.chunk", created, model };
  const chunks: unknown[] = [];
  const choice = (delta: unknown, finishReason: string | null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  if ("text" in turn) {
    const [first, second] = splitText(turn.text);
    chunks.push(choice({ role: "assistant", content: first }, null));
    if (second !== "") {
      chunks.push(choice({ content: second }, null));
    }
    chunks.push(choice({}, "stop"));
  } else {
    const toolCalls = turn.toolCalls.map((call, index) => ({
      index,
      id: `call_${nextCallNumber()}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
    chunks.push(choice({ role: "assistant", tool_calls: toolCalls }, null));
    chunks.push(choice({}, "tool_calls"));
  }

  // Usage travels in a final chunk without choices, as stream_options.include_usage asks.
  chunks.push({ ...base, choices: [], usage: usage() });
  return chunks;
}

/** Non-streaming completion of one turn. */
function completion(
  turn: ScriptedTurn,
  model: string,
  created: number,
  nextCallNumber: () => number,
): unknown {
  const base = { id: `chatcmpl-mock-${created}`, object: "chat.completion", created, model };
  if ("text" in turn) {
    return {
      ...base,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: turn.text },
          finish_reason: "stop",
        },
      ],
      usage: usage(),
    };
  }
  return {
    ...base,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: turn.toolCalls.map((call) => ({
            id: `call_${nextCallNumber()}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: usage(),
  };
}

/** Splits text in two chunks at the middle (by code points), so streams have a delta to join. */
function splitText(text: string): [string, string] {
  const characters = [...text];
  const middle = Math.ceil(characters.length / 2);
  return [characters.slice(0, middle).join(""), characters.slice(middle).join("")];
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
