import "./styles.css";
import type { SessionInfo } from "@cna/shared";
import { ApiClient, ApiClientError, followEvents } from "@cna/shared/client";
import { h, text } from "./dom.js";
import { initialViewState, reduceView, type ViewAction, type ViewState } from "./state.js";
import { Store } from "./store.js";
import { browserStores, clearToken, loadToken, saveToken } from "./token.js";
import { createComposer, type SendMode } from "./views/composer.js";
import { createDiffPanel } from "./views/diff.js";
import { statusLabel } from "./views/format.js";
import { createHeader } from "./views/header.js";
import { createHistoryPanel } from "./views/history.js";
import { createLoginView } from "./views/login.js";
import { createNetworkPanel } from "./views/network.js";
import { createNewSessionView } from "./views/new-session.js";
import { createQuestionsPanel } from "./views/questions.js";
import { createTodosPanel } from "./views/todos.js";
import { createTranscript } from "./views/transcript.js";
import { createUsagePanel } from "./views/usage.js";

/** How long an error notice stays on screen. */
const TOAST_MS = 8000;
const CLOSE_QUESTION = "¿Cerrar la sesión? Se borrará el workspace.";
const FORCE_CLOSE_QUESTION = "Hay cambios sin subir. ¿Cerrar igualmente y descartarlos?";

type TabName = "todos" | "diff" | "network" | "usage";

const TABS: ReadonlyArray<{ name: TabName; label: string }> = [
  { name: "todos", label: "Tareas" },
  { name: "diff", label: "Diff" },
  { name: "network", label: "Red" },
  { name: "usage", label: "Uso" },
];

const mountPoint = document.getElementById("app");
if (!mountPoint) {
  throw new Error('missing element "#app"');
}
// Typed without null: the functions below use it, and TypeScript does not narrow across them.
const root: HTMLElement = mountPoint;

/** Stops the running app (event stream, store subscriptions, timers). Set while the app is mounted. */
let stopApp: (() => void) | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "error desconocido";
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}

/** Shows the token form. Leaving the app first stops everything it started. */
function showLogin(message?: string): void {
  stopApp?.();
  stopApp = undefined;
  document.title = "cna";
  root.replaceChildren(
    createLoginView((token, remember) => {
      saveToken(token, remember, browserStores());
      void start(token);
    }, message),
  );
}

/** The server did not answer, or answered with an error other than 401. */
function showConnectionError(token: string, error: unknown): void {
  root.replaceChildren(
    h(
      "section",
      { class: "app-error" },
      h("p", {
        class: "app-error-message",
        attrs: { role: "alert" },
        text: `No se puede conectar con el servidor: ${errorMessage(error)}`,
      }),
      h("button", {
        class: "app-error-retry",
        attrs: { type: "button" },
        text: "Reintentar",
        on: { click: () => void start(token) },
      }),
    ),
  );
}

/** Checks the token with GET /session, then mounts the app. */
async function start(token: string): Promise<void> {
  root.replaceChildren(
    h("p", { class: "app-loading", attrs: { role: "status" }, text: "Conectando…" }),
  );
  const client = new ApiClient({ baseUrl: "", token });
  let session: SessionInfo | null;
  try {
    session = await client.getSession();
  } catch (error) {
    if (isUnauthorized(error)) {
      clearToken(browserStores());
      showLogin("Token no válido");
    } else {
      showConnectionError(token, error);
    }
    return;
  }
  mountApp(client, session);
}

/** Builds the app once per login: layout, store, views and the event stream. */
function mountApp(client: ApiClient, initial: SessionInfo | null): void {
  const controller = new AbortController();
  const { signal } = controller;
  const disposers: Array<() => void> = [];
  let stopped = false;
  let toastTimer: number | undefined;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    controller.abort();
    window.clearTimeout(toastTimer);
    for (const dispose of disposers) {
      dispose();
    }
  };
  stopApp = stop;

  const store = new Store<ViewState, ViewAction>(initialViewState, reduceView);
  store.dispatch({ type: "session", session: initial });

  const toast = h("div", { class: "app-toast", attrs: { role: "status", hidden: true } });

  function showToast(message: string): void {
    if (stopped) {
      return;
    }
    toast.replaceChildren(text(message));
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, TOAST_MS);
  }

  function unauthorized(): void {
    if (stopped) {
      return;
    }
    clearToken(browserStores());
    showLogin("Token no válido");
  }

  /** 401 goes back to the login; anything else is shown as a notice. */
  function reportError(error: unknown): void {
    if (stopped) {
      return;
    }
    if (isUnauthorized(error)) {
      unauthorized();
      return;
    }
    showToast(errorMessage(error));
  }

  /** Copies a slice of the state into a view. Updates are coalesced into one frame. */
  function connect<T>(
    select: (state: ViewState) => T,
    update: (value: T) => void,
    equals: (a: T, b: T) => boolean = Object.is,
  ): void {
    let last = select(store.state);
    update(last);
    let scheduled = false;
    disposers.push(
      store.subscribe(() => {
        if (scheduled || stopped) {
          return;
        }
        scheduled = true;
        window.requestAnimationFrame(() => {
          scheduled = false;
          if (stopped) {
            return;
          }
          const next = select(store.state);
          if (equals(next, last)) {
            return;
          }
          last = next;
          update(next);
        });
      }),
    );
  }

  // Session refresh: at most one GET /session in flight; requests in the meantime collapse into one.
  let sessionInFlight = false;
  let sessionPending = false;
  function refreshSession(): void {
    if (stopped) {
      return;
    }
    if (sessionInFlight) {
      sessionPending = true;
      return;
    }
    sessionInFlight = true;
    void client
      .getSession()
      .then((session) => {
        if (!stopped) {
          store.dispatch({ type: "session", session });
        }
      }, reportError)
      .finally(() => {
        sessionInFlight = false;
        if (sessionPending) {
          sessionPending = false;
          refreshSession();
        }
      });
  }

  /** Network log and checkpoints. Errors are ignored (e.g. 404 without a session). */
  function loadAuxiliary(): void {
    void client.networkLog().then(
      (entries) => {
        if (!stopped) {
          store.dispatch({ type: "networkLog", entries });
        }
      },
      () => undefined,
    );
    void client.checkpoints().then(
      (checkpoints) => {
        if (!stopped) {
          store.dispatch({ type: "checkpoints", checkpoints });
        }
      },
      () => undefined,
    );
  }

  function reloadMessages(): void {
    void client.messages().then((messages) => {
      if (!stopped) {
        store.dispatch({ type: "messages", messages });
      }
    }, reportError);
  }

  async function closeSession(): Promise<void> {
    if (!confirm(CLOSE_QUESTION)) {
      return;
    }
    try {
      try {
        await client.closeSession();
      } catch (error) {
        if (!(error instanceof ApiClientError && error.code === "invalid_state")) {
          throw error;
        }
        if (!confirm(FORCE_CLOSE_QUESTION)) {
          return;
        }
        await client.closeSession({ force: true });
      }
      const session = await client.getSession();
      if (!stopped) {
        store.dispatch({ type: "session", session });
      }
    } catch (error) {
      reportError(error);
    }
  }

  // Event stream: it runs for as long as the app is open, with or without a session.
  async function followLoop(): Promise<void> {
    try {
      for await (const item of followEvents(client, { signal })) {
        if (stopped) {
          return;
        }
        switch (item.kind) {
          case "event":
            store.dispatch({ type: "event", event: item.event });
            if (item.event.event.type === "status") {
              refreshSession();
            }
            break;
          case "truncated":
            store.dispatch({ type: "truncated" });
            break;
          case "reset":
            store.dispatch({ type: "reset" });
            refreshSession();
            loadAuxiliary();
            break;
        }
      }
    } catch (error) {
      reportError(error);
    }
  }

  // Views. Each one owns its element; the connections below feed them.
  const header = createHeader({
    abort: () => {
      void client.abort().catch(reportError);
    },
    close: () => {
      void closeSession();
    },
    logout: () => {
      clearToken(browserStores());
      showLogin();
    },
  });
  const transcript = createTranscript(reloadMessages);
  const questions = createQuestionsPanel((id, body) => client.answer(id, body));
  const composer = createComposer(async (message: string, mode: SendMode) => {
    await client.postMessage({ text: message, mode });
  });
  const todos = createTodosPanel();
  const diff = createDiffPanel({
    loadDiff: (checkpoint) => client.diff(checkpoint),
    restore: async (id, conversation) => {
      const result = await client.restoreCheckpoint(id, { conversation });
      if (result.conversationRestored) {
        store.dispatch({ type: "messages", messages: await client.messages() });
      }
    },
  });
  const network = createNetworkPanel({
    loadPolicy: () => client.networkPolicy(),
    setMode: (mode) => client.updateNetworkPolicy({ mode }),
  });
  const usage = createUsagePanel(() => client.stats());

  const panels: Record<TabName, HTMLElement> = {
    todos: todos.element,
    diff: diff.element,
    network: network.element,
    usage: usage.element,
  };
  const tabs = TABS.map((tab) => ({
    name: tab.name,
    button: h("button", {
      class: "app-tab",
      attrs: {
        type: "button",
        role: "tab",
        id: `app-tab-${tab.name}`,
        "aria-controls": `app-panel-${tab.name}`,
        "aria-selected": "false",
      },
      on: { click: () => selectTab(tab.name) },
      text: tab.label,
    }),
    box: h(
      "div",
      {
        class: "app-panel",
        attrs: {
          role: "tabpanel",
          id: `app-panel-${tab.name}`,
          "aria-labelledby": `app-tab-${tab.name}`,
        },
      },
      panels[tab.name],
    ),
  }));

  /** The visible tab of the side panel; the usage panel reloads when it is shown. */
  let activeTab: TabName = "todos";

  function selectTab(name: TabName): void {
    activeTab = name;
    for (const tab of tabs) {
      const selected = tab.name === name;
      tab.button.setAttribute("aria-selected", selected ? "true" : "false");
      tab.box.hidden = !selected;
    }
    if (name === "diff") {
      diff.refresh();
    }
    if (name === "network") {
      network.refresh();
    }
    if (name === "usage") {
      usage.refresh();
    }
  }

  const newZone = h("div", { class: "app-new" });
  const chat = h(
    "div",
    { class: "app-chat" },
    transcript.element,
    questions.element,
    composer.element,
  );
  const side = h(
    "aside",
    { class: "app-side", attrs: { "aria-label": "Paneles" } },
    h(
      "div",
      { class: "app-tabs", attrs: { role: "tablist", "aria-label": "Paneles" } },
      ...tabs.map((tab) => tab.button),
    ),
    ...tabs.map((tab) => tab.box),
  );
  const sessionZone = h("div", { class: "app-main" }, chat, side);

  /** Without a live session: the form and the history, built fresh each time it is entered. */
  function showZone(newSession: boolean): void {
    newZone.hidden = !newSession;
    sessionZone.hidden = newSession;
    if (newSession) {
      const historyPanel = createHistoryPanel({
        loadHistory: () => client.history(),
        resume: async (id) => {
          // As the submit below: drop the old transcript before the resumed session's events arrive.
          store.dispatch({ type: "reset" });
          const info = await client.resumeSession(id);
          if (!stopped) {
            store.dispatch({ type: "session", session: info });
          }
        },
      });
      newZone.replaceChildren(
        createNewSessionView({
          loadModels: () => client.models(),
          submit: async (request) => {
            // Drop the closed session's transcript before the new one's events can arrive.
            store.dispatch({ type: "reset" });
            const info = await client.createSession(request);
            if (!stopped) {
              store.dispatch({ type: "session", session: info });
            }
          },
        }),
        historyPanel.element,
      );
      historyPanel.refresh();
    } else {
      newZone.replaceChildren();
      selectTab("todos");
    }
  }

  root.replaceChildren(h("div", { class: "app" }, header.element, newZone, sessionZone, toast));

  connect(
    (s) => s.session,
    (session) => header.update(session),
  );
  connect(
    (s) => ({ items: s.transcript, truncated: s.truncated }),
    (view) => transcript.update(view),
    (a, b) => a.items === b.items && a.truncated === b.truncated,
  );
  connect(
    (s) => s.questions,
    (value) => questions.update(value),
  );
  connect(
    (s) => s.session?.status ?? null,
    (status) => composer.update(status),
  );
  connect(
    (s) => s.session?.status ?? null,
    (status) => {
      // Usage numbers change with each turn: reload them when the session is ready, if shown.
      if (status === "ready" && activeTab === "usage") {
        usage.refresh();
      }
    },
  );
  connect(
    (s) => s.todos,
    (value) => todos.update(value),
  );
  connect(
    (s) => s.checkpoints,
    (value) => diff.update(value),
  );
  connect(
    (s) => s.network,
    (value) => network.update(value),
  );
  connect(
    (s) => s.session === null || s.session.status === "closed",
    (value) => showZone(value),
  );
  connect(
    (s) => s.session?.status ?? null,
    (status) => {
      document.title = status === null ? "cna" : `cna · ${statusLabel(status)}`;
    },
  );

  void followLoop();
  loadAuxiliary();
}

const saved = loadToken(browserStores());
if (saved === null) {
  showLogin();
} else {
  void start(saved);
}
