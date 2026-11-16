import { MODE_ENTRY_TYPE, SUBMIT_PLAN_TOOL_NAME } from "@cna/shared";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import planModeExtension, {
  isReadOnlyCommand,
  PLAN_CONTEXT_TYPE,
  PLAN_FLAG,
  PLAN_MODE_TOOLS,
} from "../src/plan-mode.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ToolResult {
  content: { type: string; text: string }[];
  details: { approved: boolean; feedback?: string };
}

interface CapturedTool {
  name: string;
  label: string;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<ToolResult>;
}

interface Setup {
  pi: {
    registerFlag: ReturnType<typeof vi.fn>;
    registerTool: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
    getActiveTools: ReturnType<typeof vi.fn>;
    setActiveTools: ReturnType<typeof vi.fn>;
  };
  active: string[];
  handlers: Map<string, Handler>;
  tool: CapturedTool;
  ui: { select: ReturnType<typeof vi.fn>; editor: ReturnType<typeof vi.fn> };
  branch: unknown[];
  /** Starts the session: runs session_start with the given flag value and branch. */
  start(options?: { flag?: boolean; branch?: unknown[] }): Promise<void>;
  /** Runs a handler registered with pi.on and returns its result. */
  emit(name: string, event: unknown): Promise<unknown>;
  /** Calls submit_plan with the given parameters. */
  submit(params: Record<string, unknown>): Promise<ToolResult>;
}

const ALL_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "git_status",
  "ask_user",
  "todo",
  "web_search",
  "web_fetch",
  "questionnaire",
];

function setup(initialActive: string[] = ALL_TOOLS): Setup {
  let active = [...initialActive];
  let flagValue = false;
  const handlers = new Map<string, Handler>();
  let tool: CapturedTool | undefined;
  const branch: unknown[] = [];

  const pi = {
    registerFlag: vi.fn(),
    registerTool: vi.fn((definition: unknown) => {
      tool = definition as CapturedTool;
    }),
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((names: string[]) => {
      active = [...names];
    }),
    getFlag: vi.fn((name: string) => (name === PLAN_FLAG ? flagValue : undefined)),
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
  };
  planModeExtension(pi as unknown as ExtensionAPI);

  const ui = {
    select: vi.fn(),
    editor: vi.fn(),
  };
  const ctx = {
    cwd: "/tmp/unused",
    ui,
    sessionManager: { getBranch: () => branch },
  };

  const emit = async (name: string, event: unknown): Promise<unknown> => {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`no handler for ${name}`);
    return handler(event, ctx);
  };

  const submit = (params: Record<string, unknown>): Promise<ToolResult> => {
    if (tool === undefined) throw new Error("submit_plan was not registered");
    return tool.execute("call-1", params, undefined, undefined, ctx);
  };

  return {
    pi,
    get active() {
      return active;
    },
    handlers,
    get tool() {
      if (tool === undefined) throw new Error("submit_plan was not registered");
      return tool;
    },
    ui,
    branch,
    async start(options = {}) {
      flagValue = options.flag ?? false;
      branch.splice(0, branch.length, ...(options.branch ?? []));
      await emit("session_start", { type: "session_start", reason: "startup" });
    },
    emit,
    submit,
  };
}

function bashCall(command: string) {
  return { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command } };
}

function toolCall(toolName: string) {
  return { type: "tool_call", toolCallId: "call-1", toolName, input: {} };
}

function modeEntry(mode: string) {
  return { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode } };
}

describe("plan-mode registration", () => {
  it("registers the cna-plan flag and the submit_plan tool", () => {
    const { pi, tool } = setup();
    expect(pi.registerFlag).toHaveBeenCalledWith(
      "cna-plan",
      expect.objectContaining({ type: "boolean", default: false }),
    );
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    expect(tool.name).toBe(SUBMIT_PLAN_TOOL_NAME);
    expect(tool.label).toBe("Submit plan");
  });

  it("names submit_plan in every prompt guideline", () => {
    const { tool } = setup();
    const guidelines = tool.promptGuidelines ?? [];
    expect(guidelines.length).toBeGreaterThan(0);
    for (const guideline of guidelines) {
      expect(guideline).toContain("submit_plan");
    }
  });
});

describe("plan-mode session_start", () => {
  it("stays in auto with an empty branch and no flag, and drops submit_plan from the active tools", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: false });

    expect(s.active).toEqual(ALL_TOOLS.filter((name) => name !== SUBMIT_PLAN_TOOL_NAME));
    expect(s.active).not.toContain(SUBMIT_PLAN_TOOL_NAME);
    const blocked = await s.emit("tool_call", toolCall("write"));
    expect(blocked).toBeUndefined();
  });

  it("enters plan mode with the flag and sets exactly PLAN_MODE_TOOLS", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });

    expect(s.pi.setActiveTools).toHaveBeenLastCalledWith([...PLAN_MODE_TOOLS]);
    expect(s.active).toEqual([...PLAN_MODE_TOOLS]);
  });

  it("stays in auto when the last cna.mode entry says auto, even with the flag", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true, branch: [modeEntry("auto")] });

    expect(s.active).toEqual(ALL_TOOLS.filter((name) => name !== SUBMIT_PLAN_TOOL_NAME));
    const result = await s.emit("tool_call", toolCall("write"));
    expect(result).toBeUndefined();
  });

  it("enters plan mode when the last cna.mode entry says plan, even without the flag", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: false, branch: [modeEntry("auto"), modeEntry("plan")] });

    expect(s.active).toEqual([...PLAN_MODE_TOOLS]);
    const result = await s.emit("tool_call", toolCall("write"));
    expect(result).toEqual({
      block: true,
      reason: "Plan mode: write is not available until the plan is approved.",
    });
  });

  it("ignores cna.mode entries with an invalid mode or another customType", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({
      flag: true,
      branch: [modeEntry("bogus"), { type: "custom", customType: "other", data: { mode: "auto" } }],
    });

    expect(s.active).toEqual([...PLAN_MODE_TOOLS]);
  });

  it("uses the last valid cna.mode entry even when invalid ones follow it", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: false, branch: [modeEntry("plan"), modeEntry("bogus")] });

    expect(s.active).toEqual([...PLAN_MODE_TOOLS]);
  });
});

describe("plan-mode tool_call", () => {
  it("blocks mutating tools and the commands that are not read-only in plan mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });

    for (const call of [
      toolCall("write"),
      toolCall("edit"),
      bashCall("rm -rf x"),
      bashCall("echo hi > f"),
      bashCall("npm install"),
      bashCall("git commit -m x"),
      bashCall("curl https://x"),
      bashCall("env"),
      bashCall("ls && python script.py"),
      bashCall("cat a; npm test"),
      bashCall("echo $(make build)"),
      bashCall("ls `make`"),
      bashCall("cat a || make"),
      bashCall("cat a | python -"),
      bashCall("find . -name '*.tmp' -delete"),
      bashCall("find . -exec touch {} +"),
      bashCall("sort -o out.txt in.txt"),
      bashCall("sed -n -i 's/a/b/' f"),
      bashCall("git branch feature"),
      bashCall("git branch -m old new"),
      bashCall("git remote add x https://x"),
      bashCall("awk 'BEGIN { system(\"make\") }'"),
      bashCall("sleep 100 &"),
    ]) {
      const result = await s.emit("tool_call", call);
      expect(result).toMatchObject({ block: true });
    }
  });

  it("allows read-only tools and commands in plan mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });

    for (const call of [
      bashCall("ls -la"),
      bashCall("cat a.txt"),
      bashCall("git status"),
      bashCall("git grep foo"),
      bashCall("rg foo"),
      bashCall("git log --oneline | head -5"),
      bashCall("cat a.txt | grep foo | sort | uniq"),
      bashCall("git branch -a"),
      bashCall("git branch"),
      bashCall("git remote -v"),
      bashCall("find . -name '*.ts'"),
      toolCall("read"),
    ]) {
      const result = await s.emit("tool_call", call);
      expect(result).toBeUndefined();
    }
  });

  it("does not block anything in auto mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: false });

    expect(await s.emit("tool_call", toolCall("write"))).toBeUndefined();
    expect(await s.emit("tool_call", bashCall("rm -rf x"))).toBeUndefined();
  });
});

describe("submit_plan", () => {
  it("approves the plan: asks with the plan title, leaves plan mode and records auto", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });
    s.ui.select.mockResolvedValue("approve");

    const result = await s.submit({ plan: "1. Read the code\n2. Change it" });

    expect(s.ui.select).toHaveBeenCalledTimes(1);
    const [title, options] = s.ui.select.mock.calls[0] as [string, string[]];
    expect(title.startsWith("cna:plan:")).toBe(true);
    expect(title).toContain("1. Read the code");
    expect(options).toEqual(["approve", "request_changes"]);
    expect(s.pi.appendEntry).toHaveBeenCalledWith("cna.mode", { mode: "auto" });
    expect(result.content).toEqual([
      { type: "text", text: "The user approved the plan. Implement it now, step by step." },
    ]);
    expect(result.details).toEqual({ approved: true });
    expect(s.active).toEqual(ALL_TOOLS.filter((name) => name !== SUBMIT_PLAN_TOOL_NAME));
    expect(s.active).not.toContain(SUBMIT_PLAN_TOOL_NAME);
    expect(await s.emit("tool_call", toolCall("write"))).toBeUndefined();
  });

  it("refuses a second submission after the approval", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });
    s.ui.select.mockResolvedValue("approve");
    await s.submit({ plan: "1. Do it" });

    await expect(s.submit({ plan: "1. Do it again" })).rejects.toThrow("Not in plan mode");
    expect(s.pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("request_changes with feedback stays in plan mode and returns the feedback", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });
    s.ui.select.mockResolvedValue("request_changes");
    s.ui.editor.mockResolvedValue("  Add a migration step.  ");

    const result = await s.submit({ plan: "1. Change the schema" });

    expect(s.ui.editor).toHaveBeenCalledWith(expect.stringMatching(/^cna:plan:/));
    expect(result.content[0]?.text).toContain("Add a migration step.");
    expect(result.content[0]?.text).toContain("Revise the plan and call submit_plan again.");
    expect(result.details).toEqual({ approved: false, feedback: "Add a migration step." });
    expect(s.pi.appendEntry).not.toHaveBeenCalled();
    expect(s.active).toEqual([...PLAN_MODE_TOOLS]);
    expect(await s.emit("tool_call", toolCall("write"))).toMatchObject({ block: true });
  });

  it.each([
    ["an empty editor", ""],
    ["a blank editor", "   "],
    ["a cancelled editor", undefined],
  ])("request_changes with %s asks the user through ask_user", async (_label, feedback) => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });
    s.ui.select.mockResolvedValue("request_changes");
    s.ui.editor.mockResolvedValue(feedback);

    const result = await s.submit({ plan: "1. Step" });

    expect(result.content[0]?.text).toContain("ask_user");
    expect(result.details).toEqual({ approved: false });
    expect(s.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("throws when the user does not answer", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });
    s.ui.select.mockResolvedValue(undefined);

    await expect(s.submit({ plan: "1. Step" })).rejects.toThrow(
      "The user did not answer the plan.",
    );
    expect(s.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("throws when the plan is empty or not a string", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });

    await expect(s.submit({ plan: "   " })).rejects.toThrow("The plan is empty.");
    await expect(s.submit({ plan: 42 })).rejects.toThrow("The plan is empty.");
    expect(s.ui.select).not.toHaveBeenCalled();
  });

  it("throws on an unknown answer and stays in plan mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });
    s.ui.select.mockResolvedValue("maybe");

    await expect(s.submit({ plan: "1. Step" })).rejects.toThrow("Unknown answer");
    expect(s.pi.appendEntry).not.toHaveBeenCalled();
    expect(s.active).toEqual([...PLAN_MODE_TOOLS]);
  });
});

describe("plan-mode before_agent_start", () => {
  it("injects the plan context for user prompts in plan mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });

    const result = (await s.emit("before_agent_start", {
      type: "before_agent_start",
      messageType: "user",
      prompt: "hi",
    })) as {
      message: { customType: string; content: string; display: boolean };
    };

    expect(result.message.customType).toBe(PLAN_CONTEXT_TYPE);
    expect(result.message.display).toBe(false);
    expect(result.message.content).toContain("submit_plan");
  });

  it("injects nothing for custom runs in plan mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });

    const result = await s.emit("before_agent_start", {
      type: "before_agent_start",
      messageType: "custom",
    });
    expect(result).toBeUndefined();
  });

  it("injects nothing in auto mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: false });

    const result = await s.emit("before_agent_start", {
      type: "before_agent_start",
      messageType: "user",
      prompt: "hi",
    });
    expect(result).toBeUndefined();
  });
});

describe("plan-mode context", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "user", customType: PLAN_CONTEXT_TYPE, content: "plan context" },
    { role: "assistant", content: [] },
  ];

  it("removes the plan context messages in auto mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: false });

    const result = await s.emit("context", { type: "context", messages });
    expect(result).toEqual({ messages: [messages[0], messages[2]] });
  });

  it("keeps the messages untouched in plan mode", async () => {
    const s = setup(ALL_TOOLS);
    await s.start({ flag: true });

    const result = await s.emit("context", { type: "context", messages });
    expect(result).toBeUndefined();
  });
});

describe("isReadOnlyCommand", () => {
  it("rejects empty commands", () => {
    expect(isReadOnlyCommand("")).toBe(false);
    expect(isReadOnlyCommand("   ")).toBe(false);
  });

  it("accepts the read-only version checks", () => {
    expect(isReadOnlyCommand("mvn -v")).toBe(true);
    expect(isReadOnlyCommand("mvn --version")).toBe(true);
    expect(isReadOnlyCommand("go version")).toBe(true);
    expect(isReadOnlyCommand("java -version")).toBe(true);
  });

  it("rejects the commands removed from the allowlist", () => {
    for (const command of [
      "env",
      "printenv",
      "curl https://x",
      "wget -O - https://x",
      "top",
      "htop",
      "less a.txt",
      "more a.txt",
    ]) {
      expect(isReadOnlyCommand(command)).toBe(false);
    }
  });
});
