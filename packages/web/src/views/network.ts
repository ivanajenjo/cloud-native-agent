import "./network.css";
import type { NetworkLogEntry, NetworkMode, NetworkPolicyResponse } from "@cna/shared";
import { NETWORK_MODES } from "@cna/shared/client";
import { h, text } from "../dom.js";
import type { Component } from "./component.js";
import { formatBytes, formatClock, reasonLabel } from "./panels-format.js";

/** Rows painted in the log table, most recent first. */
const MAX_ROWS = 200;

const MODE_LABELS: Record<NetworkMode, string> = {
  ask: "Preguntar (ask)",
  allowlist: "Solo allowlist",
  audit: "Auditar (permite todo)",
};

export interface NetworkDeps {
  loadPolicy(): Promise<NetworkPolicyResponse>;
  setMode(mode: NetworkMode): Promise<NetworkPolicyResponse>;
}

export interface NetworkPanel extends Component<NetworkLogEntry[]> {
  /** Reloads the policy. */
  refresh(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listDetails(summary: string, items: string[]): HTMLDetailsElement {
  return h(
    "details",
    { class: "net-list" },
    h("summary", { text: `${summary} (${items.length})` }),
    h("ul", {}, ...items.map((item) => h("li", { text: item }))),
  );
}

function logRow(entry: NetworkLogEntry): HTMLTableRowElement {
  const decisionAllowed = entry.decision === "allow";
  return h(
    "tr",
    { attrs: { title: entry.error } },
    h("td", { text: formatClock(entry.ts) }),
    h("td", { text: entry.host === "" ? "—" : `${entry.host}:${entry.port}` }),
    h("td", {
      class: decisionAllowed ? "net-allow" : "net-deny",
      text: decisionAllowed ? "permitida" : "denegada",
    }),
    h("td", { text: reasonLabel(entry.reason) }),
    h("td", {
      class: "net-bytes",
      text: `↑ ${formatBytes(entry.bytesOut)} / ↓ ${formatBytes(entry.bytesIn)}`,
    }),
    h("td", { class: "net-duration", text: `${Math.round(entry.durationMs)} ms` }),
  );
}

/**
 * Network panel: policy (mode and lists) and the connection log. It does not load anything by
 * itself; call `refresh()` to load the policy.
 */
export function createNetworkPanel(deps: NetworkDeps): NetworkPanel {
  /** Identifies the last policy request or change; older responses are discarded. */
  let policySeq = 0;
  let currentMode: NetworkMode | undefined;

  const select = h("select", { class: "net-mode", on: { change: () => changeMode() } });
  for (const mode of NETWORK_MODES) {
    select.append(h("option", { attrs: { value: mode }, text: MODE_LABELS[mode] }));
  }
  const policyMessage = h("div", { class: "net-messages", attrs: { "aria-live": "polite" } });
  const policyDetails = h("div", { class: "net-policy-details" });
  const logBody = h("tbody");

  const element = h(
    "div",
    { class: "net-panel" },
    h(
      "section",
      { class: "net-policy" },
      h("h3", { text: "Política de red" }),
      h("label", { class: "net-mode-label" }, text("Modo "), select),
      policyMessage,
      policyDetails,
    ),
    h(
      "section",
      { class: "net-log" },
      h("h3", { text: "Conexiones" }),
      h(
        "table",
        { class: "net-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { text: "Hora" }),
            h("th", { text: "Destino" }),
            h("th", { text: "Decisión" }),
            h("th", { text: "Motivo" }),
            h("th", { text: "Bytes" }),
            h("th", { text: "Duración" }),
          ),
        ),
        logBody,
      ),
    ),
  );

  function showMessage(message: string, isError: boolean): void {
    policyMessage.replaceChildren(
      ...(message === ""
        ? []
        : [h("p", { class: isError ? "net-error" : "net-loading", text: message })]),
    );
  }

  function renderPolicy(policy: NetworkPolicyResponse): void {
    currentMode = policy.mode;
    select.value = policy.mode;
    policyDetails.replaceChildren(
      listDetails("Allowlist del usuario", policy.allow),
      listDetails("Base", policy.base),
      listDetails("Servicios", policy.services),
      h("p", { class: "net-ports", text: `Puertos: ${policy.allowedPorts.join(", ")}` }),
    );
  }

  function refresh(): void {
    const seq = ++policySeq;
    showMessage("Cargando…", false);
    deps.loadPolicy().then(
      (policy) => {
        if (seq !== policySeq) return;
        showMessage("", false);
        renderPolicy(policy);
      },
      (error: unknown) => {
        if (seq !== policySeq) return;
        showMessage(errorMessage(error), true);
      },
    );
  }

  function changeMode(): void {
    const mode = NETWORK_MODES.find((candidate) => candidate === select.value);
    if (mode === undefined) return;
    const seq = ++policySeq;
    select.disabled = true;
    showMessage("Guardando…", false);
    deps
      .setMode(mode)
      .then(
        (policy) => {
          if (seq !== policySeq) return;
          showMessage("", false);
          renderPolicy(policy);
        },
        (error: unknown) => {
          if (seq !== policySeq) return;
          // Back to the mode that was in effect before the change.
          select.value = currentMode ?? "";
          showMessage(errorMessage(error), true);
        },
      )
      .finally(() => {
        select.disabled = false;
      });
  }

  return {
    element,
    update(entries: NetworkLogEntry[]): void {
      // The API sends the oldest first; the table shows the most recent first.
      const rows = [...entries].reverse().slice(0, MAX_ROWS).map(logRow);
      if (rows.length === 0) {
        logBody.replaceChildren(
          h(
            "tr",
            {},
            h("td", {
              class: "net-empty",
              attrs: { colspan: 6 },
              text: "Sin conexiones registradas",
            }),
          ),
        );
        return;
      }
      logBody.replaceChildren(...rows);
    },
    refresh,
  };
}
