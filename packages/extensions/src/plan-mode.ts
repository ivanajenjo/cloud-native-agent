/**
 * Extension `plan-mode` (feature 2): a read-only planning phase. The gateway starts Pi with
 * `--cna-plan` when a session is created with `mode: "plan"`. In plan mode the agent only
 * explores, asks with `ask_user` and presents a plan with `submit_plan`. When the user approves
 * the plan, the extension activates the rest of the tools and reports `mode: "auto"` to the
 * gateway (`cna.mode`, ADR-0007). Adapted from Pi's `examples/extensions/plan-mode`.
 */

import {
  encodeQuestionTitle,
  MODE_ENTRY_TYPE,
  type ModeEntryData,
  PLAN_ANSWER_OPTIONS,
  parseModeEntry,
  SUBMIT_PLAN_TOOL_NAME,
} from "@cna/shared";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const PLAN_FLAG = "cna-plan";

/** Tools active in plan mode (Pi ignores names that do not exist). */
export const PLAN_MODE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "git_status",
  "ask_user",
  "todo",
  "web_search",
  "web_fetch",
  SUBMIT_PLAN_TOOL_NAME,
] as const;

/** `customType` of the context message injected in plan mode and filtered out otherwise. */
export const PLAN_CONTEXT_TYPE = "cna-plan-context";

// Destructive commands blocked in plan mode. Copied from Pi's plan-mode utils.
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
  // Not in Pi's example: read-only commands with options that write or run something.
  /\bfind\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/i,
  /\bsort\b.*\s(-o|--output)\b/i,
  /\bsed\b.*\s(-i|--in-place)/i,
  /\bgit\s+branch\s+[^-\s]/i,
  /\bgit\s+branch\b.*\s(-[mMcC]|--move|--copy|--set-upstream-to|-u)\b/i,
  /\bgit\s+remote\s+(add|set-url|remove|rm|rename|prune|set-head)\b/i,
  /\bsystem\s*\(/i,
];

/** Command chaining, substitution or background jobs: only plain pipes are accepted. */
const CHAINING_PATTERN = /[;&`\n]|\$\(|\|\|/;

// Read-only commands allowed in plan mode. Copied from Pi's plan-mode utils, minus the commands
// that print the environment (env, printenv) or that touch the network or are interactive
// (curl, wget, top, htop, less, more).
const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|grep|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*mvn\s+(-v|--version)\b/i,
  /^\s*go\s+version\b/i,
  /^\s*java\s+-version\b/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
];

/** True if a bash command is read-only (allowed in plan mode). Pure. */
export function isReadOnlyCommand(command: string): boolean {
  if (command.trim() === "") {
    return false;
  }
  if (CHAINING_PATTERN.test(command)) {
    return false;
  }
  // Every stage of a pipeline must be a safe command on its own.
  return command.split("|").every((stage) => {
    const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(stage));
    const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(stage));
    return !isDestructive && isSafe;
  });
}

const PLAN_CONTEXT = `[PLAN MODE ACTIVE]
You are in plan mode: a read-only phase. Do not change anything until the plan is approved.

Restrictions:
- The edit and write tools are disabled.
- bash only runs read-only commands.
- Tools other than the read-only ones, ask_user, todo, web and submit_plan are blocked.

Investigate the repository first. If you need a decision from the user, ask with ask_user.
When you have a plan, call submit_plan with a numbered list of concrete steps in Markdown.
If the user asks for changes, revise the plan and call submit_plan again.`;

const submitPlanParameters = Type.Object({
  plan: Type.String({
    description: "The plan as a numbered list of concrete steps, in Markdown.",
  }),
});

export interface SubmitPlanDetails {
  approved: boolean;
  feedback?: string;
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planMode = false;
  let toolsBeforePlan: string[] | undefined;

  pi.registerFlag(PLAN_FLAG, {
    description: "Start the session in plan mode (read-only until the plan is approved)",
    type: "boolean",
    default: false,
  });

  /** Enters plan mode: remembers the tools to restore later and activates the plan set. */
  function enterPlanMode(): void {
    planMode = true;
    if (toolsBeforePlan === undefined) {
      toolsBeforePlan = pi.getActiveTools().filter((name) => name !== SUBMIT_PLAN_TOOL_NAME);
    }
    pi.setActiveTools([...PLAN_MODE_TOOLS]);
  }

  /** Leaves plan mode: restores the tools from before the plan and hides submit_plan. */
  function leavePlanMode(): void {
    planMode = false;
    pi.setActiveTools(
      (toolsBeforePlan ?? pi.getActiveTools()).filter((name) => name !== SUBMIT_PLAN_TOOL_NAME),
    );
    toolsBeforePlan = undefined;
  }

  pi.registerTool({
    name: SUBMIT_PLAN_TOOL_NAME,
    label: "Submit plan",
    description:
      "Present the implementation plan to the user. The user approves it or asks for changes. " +
      "Only available in plan mode.",
    promptGuidelines: [
      "Use submit_plan in plan mode to present a numbered implementation plan for the user's approval before changing anything.",
    ],
    parameters: submitPlanParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!planMode) {
        throw new Error("Not in plan mode: the plan was already approved.");
      }
      // Pi validates the schema, but a non-string value must not reach the dialog either.
      const plan = typeof params.plan === "string" ? params.plan.trim() : "";
      if (plan === "") {
        throw new Error("The plan is empty.");
      }

      const answer = await ctx.ui.select(encodeQuestionTitle("plan", plan), [
        ...PLAN_ANSWER_OPTIONS,
      ]);
      if (answer === undefined) {
        throw new Error("The user did not answer the plan.");
      }

      if (answer === "approve") {
        leavePlanMode();
        pi.appendEntry(MODE_ENTRY_TYPE, { mode: "auto" } satisfies ModeEntryData);
        const details: SubmitPlanDetails = { approved: true };
        return {
          content: [
            { type: "text", text: "The user approved the plan. Implement it now, step by step." },
          ],
          details,
        };
      }

      if (answer === "request_changes") {
        const feedback = await ctx.ui.editor(
          encodeQuestionTitle("plan", "What should change in the plan?"),
        );
        const trimmed = feedback?.trim() ?? "";
        if (trimmed === "") {
          const details: SubmitPlanDetails = { approved: false };
          return {
            content: [
              {
                type: "text",
                text: "The user asked for changes without details. Ask them with ask_user what to change, then call submit_plan again.",
              },
            ],
            details,
          };
        }
        const details: SubmitPlanDetails = { approved: false, feedback: trimmed };
        return {
          content: [
            {
              type: "text",
              text: `The user asked for changes:\n${trimmed}\nRevise the plan and call submit_plan again.`,
            },
          ],
          details,
        };
      }

      throw new Error(`Unknown answer to the plan: ${answer}`);
    },
  });

  // Decides the mode from the last cna.mode entry of the branch (so a fork after the approval
  // does not go back to plan mode), else from the --cna-plan flag.
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch() as unknown[];
    let mode: "plan" | "auto" | null = null;
    for (let i = branch.length - 1; i >= 0; i--) {
      const parsed = parseModeEntry(branch[i]);
      if (parsed !== null) {
        mode = parsed;
        break;
      }
    }
    if (mode === null) {
      mode = pi.getFlag(PLAN_FLAG) === true ? "plan" : "auto";
    }

    if (mode === "plan") {
      enterPlanMode();
    } else {
      leavePlanMode();
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!planMode || event.messageType !== "user") {
      return;
    }
    return {
      message: {
        customType: PLAN_CONTEXT_TYPE,
        content: PLAN_CONTEXT,
        display: false,
      },
    };
  });

  // Removes stale plan context once the plan is approved.
  pi.on("context", async (event) => {
    if (planMode) {
      return;
    }
    return {
      messages: event.messages.filter(
        (message) => (message as { customType?: string }).customType !== PLAN_CONTEXT_TYPE,
      ),
    };
  });

  pi.on("tool_call", async (event) => {
    if (!planMode) {
      return;
    }
    if (!(PLAN_MODE_TOOLS as readonly string[]).includes(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode: ${event.toolName} is not available until the plan is approved.`,
      };
    }
    if (isToolCallEventType("bash", event)) {
      const command: unknown = event.input.command;
      if (typeof command !== "string" || !isReadOnlyCommand(command)) {
        return {
          block: true,
          reason: "Plan mode: only read-only commands are allowed until the plan is approved.",
        };
      }
    }
  });
}
