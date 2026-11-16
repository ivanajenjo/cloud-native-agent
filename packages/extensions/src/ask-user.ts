/**
 * Extension `ask_user`: lets the agent ask the user a question through Pi's dialogs.
 * The dialog kind travels in the title (`cna:ask_user:<question>`) and the gateway
 * publishes it as a `question` event (ADR-0007).
 */

import { encodeQuestionTitle } from "@cna/shared";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface AskUserDetails {
  question: string;
  answer: string;
}

const parameters = Type.Object({
  question: Type.String({
    description: "The question for the user. Make it specific and self-contained.",
  }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: "Possible answers. When present, the user picks one of them.",
    }),
  ),
  multiline: Type.Optional(
    Type.Boolean({
      description:
        "When there are no options, ask for a free-text answer in a multi-line editor instead of a single-line input.",
    }),
  ),
});

/** Rejects empty or repeated options: a select dialog cannot tell them apart. */
function assertValidOptions(options: string[]): void {
  if (options.some((option) => option.trim() === "")) {
    throw new Error("Options must be non-empty strings.");
  }
  if (new Set(options).size !== options.length) {
    throw new Error("Options must be unique.");
  }
}

export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "Ask the user a question and wait for the answer. Pass options to offer a choice; " +
      "otherwise the user types a free-text answer (use multiline for longer text). " +
      "If the user cancels or does not answer, the tool fails.",
    promptGuidelines: [
      "Use ask_user when a decision needs the user's input and you cannot infer it from the repository.",
      "Use ask_user with options when the answer is one of a few choices.",
    ],
    parameters,
    // No executionMode: several questions can be pending at the same time.
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const question = params.question.trim();
      if (question === "") {
        throw new Error("The question is empty.");
      }

      const title = encodeQuestionTitle("ask_user", question);
      const options = params.options ?? [];
      let answer: string | undefined;
      if (options.length > 0) {
        assertValidOptions(options);
        answer = await ctx.ui.select(title, options);
      } else if (params.multiline === true) {
        answer = await ctx.ui.editor(title);
      } else {
        answer = await ctx.ui.input(title);
      }

      if (answer === undefined) {
        throw new Error("The user did not answer the question.");
      }
      const details: AskUserDetails = { question, answer };
      return { content: [{ type: "text", text: answer }], details };
    },
  });
}
