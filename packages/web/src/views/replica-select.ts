import "./replica-select.css";
import type { ReplicaSummary } from "@cna/shared";
import { h } from "../dom.js";
import { replicaOptionLabel } from "./replicas-format.js";

export interface ReplicaSelectDeps {
  load(): Promise<ReplicaSummary[]>;
  /** Same meaning as ReplicasDeps.current. */
  current: string | null;
  /** Called when the user picks another replica. */
  select(name: string): void;
}

export interface ReplicaSelect {
  readonly element: HTMLElement;
  /** Reloads the options; keeps the current one selected. */
  refresh(): void;
}

/**
 * Replica selector for the header. Shown only when there are two or more replicas; with fewer,
 * or when loading fails, it stays hidden. Loads nothing by itself: call refresh().
 */
export function createReplicaSelect(deps: ReplicaSelectDeps): ReplicaSelect {
  /** Identifies the last load request; older responses are discarded. */
  let loadSeq = 0;
  /** Name of the first replica of the last successful load (the default one). */
  let defaultName: string | null = null;

  const select = h("select", {
    class: "replica-select-input",
    attrs: { id: "replica-select" },
    on: {
      change: () => {
        const name = select.value;
        const currentName = deps.current ?? defaultName;
        if (name !== "" && name !== currentName) {
          deps.select(name);
        }
      },
    },
  });

  const element = h(
    "label",
    { class: "replica-select", attrs: { for: "replica-select" } },
    h("span", { class: "replica-select-label", text: "Réplica" }),
    select,
  );
  element.hidden = true;

  function refresh(): void {
    const seq = ++loadSeq;
    deps.load().then(
      (loaded) => {
        if (seq !== loadSeq) return;
        defaultName = loaded[0]?.name ?? null;
        if (loaded.length < 2) {
          element.hidden = true;
          select.replaceChildren();
          return;
        }
        const current = deps.current ?? defaultName;
        select.replaceChildren(
          ...loaded.map((replica, index) =>
            h("option", {
              attrs: { value: replica.name },
              text: replicaOptionLabel(replica, index === 0),
            }),
          ),
        );
        select.selectedIndex = Math.max(
          0,
          loaded.findIndex((replica) => replica.name === current),
        );
        element.hidden = false;
      },
      () => {
        // Failures are not shown here: the selector just stays hidden.
        if (seq !== loadSeq) return;
        element.hidden = true;
      },
    );
  }

  return { element, refresh };
}
