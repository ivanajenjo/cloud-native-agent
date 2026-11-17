import { type Child, h } from "../dom.js";
import type { TranscriptItem } from "../state.js";
import type { Component } from "./component.js";
import { clip, formatToolDuration, prettyJson, summarizeArgs } from "./text.js";
import "./transcript.css";

export interface TranscriptView {
  items: TranscriptItem[];
  truncated: boolean;
}

/** Distance from the bottom (px) under which the view keeps following new content. */
const FOLLOW_THRESHOLD_PX = 80;
/** Max characters of a tool result shown in the card. */
const OUTPUT_LIMIT = 20000;

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

interface Entry {
  item: TranscriptItem;
  element: HTMLElement;
}

/** The conversation: messages, tool call cards and notices, with streaming and auto-scroll. */
export function createTranscript(onReload: () => void): Component<TranscriptView> {
  const banner = h(
    "div",
    { class: "transcript-banner" },
    h("span", { text: "El historial está incompleto." }),
    h("button", {
      class: "transcript-reload",
      attrs: { type: "button" },
      text: "Recargar conversación",
      on: { click: () => onReload() },
    }),
  );
  banner.hidden = true;
  const list = h("div", { class: "transcript-list" });
  const element = h("section", { class: "transcript" }, banner, list);

  /** Rendered elements by item key; an item whose reference is unchanged keeps its element. */
  let entries = new Map<string, Entry>();

  return {
    element,
    update({ items, truncated }) {
      const atBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;

      const next = new Map<string, Entry>();
      const elements: HTMLElement[] = [];
      for (const item of items) {
        const previous = entries.get(item.key);
        let rendered: HTMLElement;
        if (previous && previous.item === item) {
          rendered = previous.element;
        } else {
          rendered = renderItem(item, previous);
        }
        next.set(item.key, { item, element: rendered });
        elements.push(rendered);
      }
      entries = next;
      list.replaceChildren(...elements);

      banner.hidden = !truncated;
      if (atBottom) {
        element.scrollTop = element.scrollHeight;
      }
    },
  };
}

/** Renders one item. `previous` is the element it replaces, if any (keeps the user's toggle). */
function renderItem(item: TranscriptItem, previous: Entry | undefined): HTMLElement {
  switch (item.kind) {
    case "user":
      return h("div", { class: "msg msg-user" }, h("div", { class: "msg-text", text: item.text }));
    case "assistant":
      return renderAssistant(item);
    case "tool":
      return renderTool(item, previous);
    case "notice":
      return h("div", { class: `notice notice-${item.level}`, text: item.text });
  }
}

function renderAssistant(item: Extract<TranscriptItem, { kind: "assistant" }>): HTMLElement {
  const classes = ["msg", "msg-assistant"];
  if (item.streaming) {
    classes.push("msg-streaming");
  }
  const children: Child[] = [];
  if (item.thinking !== "") {
    children.push(
      h(
        "details",
        { class: "msg-thinking" },
        h("summary", { text: "Razonamiento" }),
        h("pre", { class: "msg-thinking-text", text: item.thinking }),
      ),
    );
  }
  children.push(h("div", { class: "msg-text", text: item.text }));
  if (item.streaming) {
    children.push(h("span", { class: "msg-indicator", text: "escribiendo…" }));
  }
  if (item.error !== undefined) {
    children.push(h("p", { class: "msg-error", text: item.error }));
  }
  return h("div", { class: classes.join(" ") }, ...children);
}

function renderTool(item: ToolItem, previous: Entry | undefined): HTMLElement {
  const icon = item.status === "running" ? "⏳" : item.status === "done" ? "✓" : "✗";
  const summary = h(
    "summary",
    { class: "tool-summary" },
    h("span", { class: "tool-icon", text: icon }),
    h("span", { class: "tool-name", text: item.toolName }),
    h("span", { class: "tool-args", text: summarizeArgs(item.args) }),
    item.durationMs !== undefined
      ? h("span", { class: "tool-duration", text: formatToolDuration(item.durationMs) })
      : null,
  );
  const output = clip(item.output, OUTPUT_LIMIT);
  const body = h(
    "div",
    { class: "tool-body" },
    h("div", { class: "tool-section-title", text: "Argumentos" }),
    h("pre", { class: "tool-pre", text: prettyJson(item.args) }),
    h("div", { class: "tool-section-title", text: "Resultado" }),
    h("pre", { class: "tool-pre", text: output.text }),
    output.clipped ? h("p", { class: "tool-note", text: "(salida recortada)" }) : null,
  );
  const card = h(
    "details",
    { class: `tool tool-${item.status}`, attrs: { open: item.status === "error" } },
    summary,
    body,
  );
  // A card replaced by a newer version of the same item keeps the user's open/closed choice,
  // unless its status changed (then the default for the new status applies).
  if (
    previous &&
    previous.element instanceof HTMLDetailsElement &&
    previous.item.kind === "tool" &&
    previous.item.status === item.status
  ) {
    card.open = previous.element.open;
  }
  return card;
}
