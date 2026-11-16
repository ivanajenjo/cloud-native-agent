import type { Question, QuestionOutcome } from "@cna/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskCoordinator } from "../src/egress/ask.js";
import type { GatewayClient } from "../src/gateway-client.js";

const TIMEOUT_MS = 120_000;

interface FakeGateway {
  publishQuestion: ReturnType<typeof vi.fn<(question: Question) => Promise<boolean>>>;
  resolveQuestion: ReturnType<
    typeof vi.fn<(id: string, outcome: QuestionOutcome) => Promise<void>>
  >;
}

/** Gateway fake: publishes successfully unless told otherwise. */
function fakeGateway(published: boolean | Promise<boolean> = true): FakeGateway {
  return {
    publishQuestion: vi.fn(async (_question: Question) => published),
    resolveQuestion: vi.fn(async (_id: string, _outcome: QuestionOutcome) => undefined),
  };
}

/** Sequential ids: net-1, net-2, ... */
function sequentialIds() {
  let counter = 0;
  return () => {
    counter += 1;
    return `net-${counter}`;
  };
}

function setup(gateway: FakeGateway, options: { timeoutMs?: number } = {}) {
  return new AskCoordinator({
    gateway: gateway as unknown as Pick<GatewayClient, "publishQuestion" | "resolveQuestion">,
    newId: sequentialIds(),
    now: () => new Date("2026-11-16T10:00:00.000Z"),
    ...options,
  });
}

/** Lets pending promise callbacks run without advancing fake timers. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ask publishes the question", () => {
  it("builds a network question with every field", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const pending = coordinator.ask("example.com", 443);
    await flush();

    expect(gateway.publishQuestion).toHaveBeenCalledTimes(1);
    expect(gateway.publishQuestion.mock.calls[0]?.[0]).toEqual({
      id: "net-1",
      kind: "network",
      method: "select",
      title: "Allow network access to example.com:443?",
      options: ["allow_once", "allow_always", "deny"],
      timeoutMs: TIMEOUT_MS,
      createdAt: "2026-11-16T10:00:00.000Z",
      network: { host: "example.com", port: 443 },
    });
    expect(coordinator.answer("net-1", "deny")).toBe("ok");
    await expect(pending).resolves.toBe("deny");
  });

  it("uses the configured timeoutMs in the question", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway, { timeoutMs: 1000 });

    const pending = coordinator.ask("example.com", 443);
    await flush();

    expect(gateway.publishQuestion.mock.calls[0]?.[0].timeoutMs).toBe(1000);
    coordinator.answer("net-1", "deny");
    await pending;
  });
});

describe("answers", () => {
  it("allow_once resolves ask, reports answered and rejects a repeated answer", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const pending = coordinator.ask("example.com", 443);
    await flush();

    expect(coordinator.answer("net-1", "allow_once")).toBe("ok");
    await expect(pending).resolves.toBe("allow_once");
    expect(gateway.resolveQuestion).toHaveBeenCalledWith("net-1", "answered");
    expect(coordinator.answer("net-1", "allow_once")).toBe("already_resolved");
    expect(coordinator.pendingIds()).toEqual([]);
  });

  it("answer with an unknown id is not_found", async () => {
    const coordinator = setup(fakeGateway());
    expect(coordinator.answer("net-missing", "deny")).toBe("not_found");
  });

  it("answer with an invalid value is invalid_value and the question stays pending", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const pending = coordinator.ask("example.com", 443);
    await flush();

    expect(coordinator.answer("net-1", "maybe")).toBe("invalid_value");
    expect(coordinator.pendingIds()).toEqual(["net-1"]);
    expect(gateway.resolveQuestion).not.toHaveBeenCalled();

    expect(coordinator.answer("net-1", "deny")).toBe("ok");
    await expect(pending).resolves.toBe("deny");
  });

  it("accepts an answer that arrives while publishQuestion is still pending", async () => {
    let finishPublish: (published: boolean) => void = () => undefined;
    const gateway = fakeGateway(
      new Promise<boolean>((resolve) => {
        finishPublish = resolve;
      }),
    );
    const coordinator = setup(gateway);

    const pending = coordinator.ask("example.com", 443);
    await flush();
    expect(coordinator.pendingIds()).toEqual(["net-1"]);

    expect(coordinator.answer("net-1", "allow_always")).toBe("ok");
    finishPublish(true);
    await expect(pending).resolves.toBe("allow_always");
    expect(gateway.resolveQuestion).toHaveBeenCalledWith("net-1", "answered");
  });
});

describe("concurrency per destination", () => {
  it("two concurrent asks for the same host:port share one question and one result", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const first = coordinator.ask("example.com", 443);
    const second = coordinator.ask("example.com", 443);
    await flush();

    expect(gateway.publishQuestion).toHaveBeenCalledTimes(1);
    coordinator.answer("net-1", "allow_once");
    await expect(Promise.all([first, second])).resolves.toEqual(["allow_once", "allow_once"]);
  });

  it("asks for the same host on different ports create two questions", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const https = coordinator.ask("example.com", 443);
    const other = coordinator.ask("example.com", 8443);
    await flush();

    expect(gateway.publishQuestion).toHaveBeenCalledTimes(2);
    expect(coordinator.pendingIds().sort()).toEqual(["net-1", "net-2"]);
    coordinator.answer("net-1", "deny");
    coordinator.answer("net-2", "allow_once");
    await expect(https).resolves.toBe("deny");
    await expect(other).resolves.toBe("allow_once");
  });

  it("a new ask after the question was resolved creates a new question", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const first = coordinator.ask("example.com", 443);
    await flush();
    coordinator.answer("net-1", "deny");
    await expect(first).resolves.toBe("deny");

    const second = coordinator.ask("example.com", 443);
    await flush();
    expect(gateway.publishQuestion).toHaveBeenCalledTimes(2);
    expect(gateway.publishQuestion.mock.calls[1]?.[0].id).toBe("net-2");
    coordinator.answer("net-2", "allow_once");
    await expect(second).resolves.toBe("allow_once");
  });
});

describe("no session", () => {
  it("publishQuestion false resolves no_session, leaves nothing pending and no timers", async () => {
    const gateway = fakeGateway(false);
    const coordinator = setup(gateway);

    await expect(coordinator.ask("example.com", 443)).resolves.toBe("no_session");
    expect(coordinator.pendingIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(gateway.resolveQuestion).not.toHaveBeenCalled();
  });

  it("the id of a question that was not published is not_found", async () => {
    const gateway = fakeGateway(false);
    const coordinator = setup(gateway);

    await coordinator.ask("example.com", 443);
    expect(coordinator.answer("net-1", "allow_once")).toBe("not_found");
  });

  it("a rejected publishQuestion counts as no_session", async () => {
    const gateway = fakeGateway();
    gateway.publishQuestion.mockRejectedValueOnce(new Error("boom"));
    const coordinator = setup(gateway);

    await expect(coordinator.ask("example.com", 443)).resolves.toBe("no_session");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("timeout", () => {
  it("resolves timeout after timeoutMs and reports it to the gateway", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const pending = coordinator.ask("example.com", 443);
    await flush();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(coordinator.pendingIds()).toEqual(["net-1"]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("timeout");
    expect(gateway.resolveQuestion).toHaveBeenCalledWith("net-1", "timeout");
    expect(coordinator.pendingIds()).toEqual([]);
  });

  it("an answer after the timeout is already_resolved", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const pending = coordinator.ask("example.com", 443);
    await flush();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(pending).resolves.toBe("timeout");

    expect(coordinator.answer("net-1", "allow_once")).toBe("already_resolved");
  });
});

describe("cancelAll", () => {
  it("resolves every pending ask as no_session and reports cancelled", async () => {
    const gateway = fakeGateway();
    const coordinator = setup(gateway);

    const first = coordinator.ask("example.com", 443);
    const second = coordinator.ask("example.org", 80);
    await flush();

    coordinator.cancelAll();

    await expect(first).resolves.toBe("no_session");
    await expect(second).resolves.toBe("no_session");
    expect(gateway.resolveQuestion).toHaveBeenCalledWith("net-1", "cancelled");
    expect(gateway.resolveQuestion).toHaveBeenCalledWith("net-2", "cancelled");
    expect(coordinator.pendingIds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(coordinator.answer("net-1", "allow_once")).toBe("already_resolved");
  });
});
