import type { CreateSessionRequest, ModelsResponse, ThinkingLevel } from "@cna/shared";
import { THINKING_LEVELS } from "@cna/shared/client";
import { h, text } from "../dom.js";
import "./new-session.css";

export interface NewSessionDeps {
  loadModels(): Promise<ModelsResponse>;
  /** Rejects with an Error (often ApiClientError) whose message is shown under the form. */
  submit(request: CreateSessionRequest): Promise<void>;
}

/** Largest pull request number accepted by the API (`CreateSessionRequestSchema`). */
const MAX_PULL_REQUEST = 1_000_000_000;

/** Form to create a session. Calls `deps.loadModels` once, when the view is created. */
export function createNewSessionView(deps: NewSessionDeps): HTMLElement {
  const repoInput = h("input", {
    class: "new-session-input",
    attrs: {
      id: "new-session-repo",
      type: "text",
      placeholder: "owner/repo",
      autocomplete: "off",
      spellcheck: "false",
      required: true,
    },
  });
  const baseBranchInput = h("input", {
    class: "new-session-input",
    attrs: {
      id: "new-session-base-branch",
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const baseBranchHelp = h("p", {
    class: "new-session-help",
    attrs: { hidden: true },
    text: "Con un PR se usa su rama base",
  });
  const prInput = h("input", {
    class: "new-session-input",
    attrs: {
      id: "new-session-pr",
      type: "number",
      min: 1,
      step: 1,
      inputmode: "numeric",
    },
    on: {
      input: () => {
        syncPullRequestState();
      },
    },
  });
  const promptInput = h("textarea", {
    class: "new-session-input new-session-prompt",
    attrs: { id: "new-session-prompt", rows: 4, required: true },
  });

  const defaultModelOption = h("option", { attrs: { value: "" }, text: "Por defecto" });
  const modelSelect = h(
    "select",
    { class: "new-session-input", attrs: { id: "new-session-model" } },
    defaultModelOption,
  );
  const modelNotice = h("p", {
    class: "new-session-hint",
    attrs: { hidden: true, role: "status" },
    text: "No se pudieron cargar los modelos.",
  });

  const thinkingSelect = h(
    "select",
    { class: "new-session-input", attrs: { id: "new-session-thinking" } },
    h("option", { attrs: { value: "" }, text: "Por defecto" }),
    ...THINKING_LEVELS.map((level) => h("option", { attrs: { value: level }, text: level })),
  );

  const autoPushInput = h("input", {
    attrs: { id: "new-session-autopush", type: "checkbox" },
  });

  const errorBox = h("p", { class: "new-session-error", attrs: { role: "alert", hidden: true } });
  const submitButton = h("button", {
    class: "new-session-submit",
    attrs: { type: "submit" },
    text: "Crear sesión",
  });

  const modeInputs = {
    auto: h("input", {
      attrs: {
        id: "new-session-mode-auto",
        type: "radio",
        name: "new-session-mode",
        value: "auto",
        checked: true,
      },
    }),
    plan: h("input", {
      attrs: {
        id: "new-session-mode-plan",
        type: "radio",
        name: "new-session-mode",
        value: "plan",
      },
    }),
  };

  function showError(message: string | null): void {
    errorBox.replaceChildren(text(message ?? ""));
    errorBox.hidden = message === null;
  }

  function setSubmitting(submitting: boolean): void {
    submitButton.disabled = submitting;
    submitButton.replaceChildren(text(submitting ? "Creando…" : "Crear sesión"));
  }

  /** With a PR the prompt is optional and the base branch is the PR's (it is not sent). */
  function syncPullRequestState(): void {
    const hasPullRequest = prInput.value.trim() !== "";
    promptInput.required = !hasPullRequest;
    promptInput.placeholder = hasPullRequest
      ? "Opcional: instrucciones además de atender la revisión"
      : "";
    baseBranchInput.disabled = hasPullRequest;
    baseBranchHelp.hidden = !hasPullRequest;
  }

  async function loadModelOptions(): Promise<void> {
    try {
      const { default: defaultRef, models } = await deps.loadModels();
      defaultModelOption.replaceChildren(
        text(defaultRef === null ? "Por defecto" : `Por defecto (${defaultRef})`),
      );
      modelSelect.append(
        ...models.map((model) =>
          h("option", {
            attrs: { value: model.ref },
            text: model.name ? `${model.name} (${model.ref})` : model.ref,
          }),
        ),
      );
    } catch {
      modelNotice.hidden = false;
    }
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const repo = repoInput.value.trim();
    const prompt = promptInput.value.trim();
    const prText = prInput.value.trim();
    if (repo === "") {
      showError("Indica el repositorio como owner/repo.");
      repoInput.focus();
      return;
    }
    const pr = prText === "" ? undefined : parsePullRequest(prText);
    // A number input reports "" for text it cannot parse: that must not become "no PR".
    if (prInput.validity.badInput || (prText !== "" && pr === undefined)) {
      showError("El número de PR no es válido");
      prInput.focus();
      return;
    }
    if (pr === undefined && prompt === "") {
      showError("Escribe el prompt de la tarea.");
      promptInput.focus();
      return;
    }

    const request: CreateSessionRequest = {
      repo,
      mode: modeInputs.plan.checked ? "plan" : "auto",
    };
    if (pr === undefined) {
      request.prompt = prompt;
      const baseBranch = baseBranchInput.value.trim();
      if (baseBranch !== "") {
        request.baseBranch = baseBranch;
      }
    } else {
      request.pr = pr;
      if (prompt !== "") {
        request.prompt = prompt;
      }
    }
    if (modelSelect.value !== "") {
      request.model = modelSelect.value;
    }
    if (thinkingSelect.value !== "") {
      request.thinking = thinkingSelect.value as ThinkingLevel;
    }
    if (autoPushInput.checked) {
      request.autoPush = true;
    }

    showError(null);
    setSubmitting(true);
    try {
      await deps.submit(request);
    } catch (error) {
      showError(
        error instanceof Error && error.message !== "" ? error.message : "Error desconocido",
      );
      setSubmitting(false);
    }
  }

  const form = h(
    "form",
    {
      class: "new-session-form",
      // Our own checks show the messages in Spanish; the browser's bubbles would pre-empt them.
      attrs: { novalidate: true },
      on: {
        submit: (event) => {
          void handleSubmit(event);
        },
      },
    },
    field("new-session-repo", "Repositorio (owner/repo)", repoInput),
    field("new-session-base-branch", "Rama base (opcional)", baseBranchInput, baseBranchHelp),
    field(
      "new-session-pr",
      "Pull request (opcional)",
      prInput,
      h("p", {
        class: "new-session-help",
        text: "Solo PRs abiertos del agente (ramas agent/*) en este repo. El agente leerá los comentarios de revisión.",
      }),
    ),
    field("new-session-prompt", "Prompt", promptInput),
    field("new-session-model", "Modelo", modelSelect),
    modelNotice,
    field("new-session-thinking", "Thinking", thinkingSelect),
    h(
      "fieldset",
      { class: "new-session-fieldset" },
      h("legend", { text: "Modo" }),
      choice(modeInputs.auto, "Auto"),
      choice(modeInputs.plan, "Plan (solo lectura hasta aprobar)"),
    ),
    h(
      "div",
      { class: "new-session-check" },
      autoPushInput,
      h("label", {
        attrs: { for: "new-session-autopush" },
        text: "Push y PR sin preguntar (autoPush)",
      }),
    ),
    errorBox,
    h("div", { class: "new-session-actions" }, submitButton),
  );

  void loadModelOptions();

  return h(
    "section",
    { class: "new-session" },
    h("h2", { class: "new-session-title", text: "Nueva sesión" }),
    form,
  );
}

/** Integer 1..MAX_PULL_REQUEST, or undefined when the text is not a valid PR number. */
function parsePullRequest(value: string): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= MAX_PULL_REQUEST ? number : undefined;
}

/** A label above a control, with an optional help text linked by aria-describedby. */
function field(id: string, label: string, control: HTMLElement, help?: HTMLElement): HTMLElement {
  if (help) {
    help.id = `${id}-help`;
    control.setAttribute("aria-describedby", help.id);
  }
  return h(
    "div",
    { class: "new-session-field" },
    h("label", { class: "new-session-label", attrs: { for: id }, text: label }),
    control,
    help,
  );
}

/** A radio button with its label. */
function choice(input: HTMLInputElement, label: string): HTMLElement {
  const id = input.id;
  return h(
    "div",
    { class: "new-session-check" },
    input,
    h("label", { attrs: { for: id }, text: label }),
  );
}
