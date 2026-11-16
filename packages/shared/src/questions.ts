/**
 * Questions shown to the user: dialogs from Pi extensions (`extension_ui_request`) and
 * network questions created by edge (ADR-0007, ADR-0008).
 */

export const QUESTION_KINDS = ["ask_user", "confirm", "plan", "network"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** Dialog methods of Pi's extension UI protocol that expect an answer. */
export const QUESTION_METHODS = ["select", "confirm", "input", "editor"] as const;
export type QuestionMethod = (typeof QUESTION_METHODS)[number];

export interface Question {
  /** Pi's `extension_ui_request.id`, or `net-<uuid>` for network questions. */
  id: string;
  kind: QuestionKind;
  method: QuestionMethod;
  /** Title without the `cna:<kind>:` prefix. */
  title: string;
  /** `confirm` only. */
  message?: string;
  /** `select` only. */
  options?: string[];
  /** `input` only. */
  placeholder?: string;
  /** `editor` only. */
  prefill?: string;
  /** If set, the question resolves by itself (as cancelled/denied) after this many ms. */
  timeoutMs?: number;
  /** ISO 8601. */
  createdAt: string;
  /** `network` only: the destination being asked about. */
  network?: { host: string; port: number };
}

/** Prefix of every network question id; edge intercepts answers to these ids (ADR-0008). */
export const NETWORK_QUESTION_ID_PREFIX = "net-";

/** Options of a network question (`method: "select"`). The answer is `{ value: <option> }`. */
export const NETWORK_ANSWER_OPTIONS = ["allow_once", "allow_always", "deny"] as const;
export type NetworkAnswerOption = (typeof NETWORK_ANSWER_OPTIONS)[number];

/** How a question stopped being pending. */
export type QuestionOutcome = "answered" | "cancelled" | "timeout";

const TITLE_PREFIX = "cna:";

/**
 * Builds the dialog title an extension passes to `ctx.ui.*`: `cna:<kind>:<title>`.
 * Pi's `extension_ui_request` carries no metadata, so the kind travels in the title.
 */
export function encodeQuestionTitle(kind: QuestionKind, title: string): string {
  return `${TITLE_PREFIX}${kind}:${title}`;
}

/**
 * Inverse of {@link encodeQuestionTitle}. A title without the prefix, or with an unknown kind,
 * is an `ask_user` question and its title is returned unchanged.
 */
export function decodeQuestionTitle(raw: string): { kind: QuestionKind; title: string } {
  if (raw.startsWith(TITLE_PREFIX)) {
    const rest = raw.slice(TITLE_PREFIX.length);
    const colon = rest.indexOf(":");
    if (colon !== -1) {
      const kind = rest.slice(0, colon);
      if ((QUESTION_KINDS as readonly string[]).includes(kind)) {
        return { kind: kind as QuestionKind, title: rest.slice(colon + 1) };
      }
    }
  }
  return { kind: "ask_user", title: raw };
}
