import {
  INTERNAL_ROUTES,
  type NetworkLogEntry,
  type PublishNetworkEntryRequest,
  type PublishQuestionRequest,
  type Question,
  type QuestionOutcome,
  type ResolveQuestionRequest,
} from "@cna/shared";

export interface GatewayClient {
  /** POST /internal/questions {question}. true only on 201. Any other status, network error or timeout → false. Never throws. */
  publishQuestion(question: Question): Promise<boolean>;
  /** POST /internal/questions/:id/resolved {outcome}. Errors are swallowed. */
  resolveQuestion(id: string, outcome: QuestionOutcome): Promise<void>;
  /** POST /internal/network {entry}. Errors are swallowed. */
  publishNetworkEntry(entry: NetworkLogEntry): Promise<void>;
}

export interface GatewayClientOptions {
  /** e.g. "http://agent:8090", no trailing slash. */
  gatewayUrl: string;
  /** Injectable for tests. Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per request (AbortSignal.timeout). Default 5000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const fetchGateway = options.fetch ?? globalThis.fetch;
  const gatewayBase = options.gatewayUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * POSTs a JSON body and returns the status. The response body is discarded unread.
   * Bodies are never logged: they may contain user data.
   */
  async function post(path: string, body: unknown): Promise<number> {
    const response = await fetchGateway(`${gatewayBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  }

  return {
    async publishQuestion(question) {
      const body: PublishQuestionRequest = { question };
      try {
        return (await post(INTERNAL_ROUTES.questions, body)) === 201;
      } catch {
        return false;
      }
    },

    async resolveQuestion(id, outcome) {
      const body: ResolveQuestionRequest = { outcome };
      try {
        await post(INTERNAL_ROUTES.questionResolved(id), body);
      } catch {
        // Swallowed by contract: the gateway being down must not block edge.
      }
    },

    async publishNetworkEntry(entry) {
      const body: PublishNetworkEntryRequest = { entry };
      try {
        await post(INTERNAL_ROUTES.network, body);
      } catch {
        // Swallowed by contract: the log line is only shown live.
      }
    },
  };
}
