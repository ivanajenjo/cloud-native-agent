export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  /** Sets textContent (ignored if children are given). */
  text?: string;
  /** Set with setAttribute. Names starting with "on" are refused (throw Error). */
  attrs?: Record<string, string | number | boolean | undefined>;
  /** addEventListener for each entry. */
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

/**
 * Creates an element with props and children. Strings and numbers become text nodes,
 * so untrusted content never goes through HTML parsing.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props) {
    if (props.class !== undefined) {
      element.className = props.class;
    }
    if (props.attrs) {
      for (const [name, value] of Object.entries(props.attrs)) {
        if (/^on/i.test(name)) {
          throw new Error(`refusing event attribute "${name}"; use props.on instead`);
        }
        if (value === undefined || value === false) {
          continue;
        }
        element.setAttribute(name, value === true ? "" : String(value));
      }
    }
    if (props.on) {
      for (const type of Object.keys(props.on) as Array<keyof HTMLElementEventMap>) {
        const listener = props.on[type];
        if (listener) {
          element.addEventListener(type, listener as EventListener);
        }
      }
    }
    if (props.text !== undefined && children.length === 0) {
      element.textContent = props.text;
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    element.append(
      typeof child === "string" || typeof child === "number" ? text(String(child)) : child,
    );
  }
  return element;
}

/** Text node. */
export function text(value: string): Text {
  return document.createTextNode(value);
}
