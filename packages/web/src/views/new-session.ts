import type { CreateSessionRequest, ModelsResponse, ThinkingLevel } from "@cna/shared";
import { THINKING_LEVELS } from "@cna/shared/client";
import { h, text } from "../dom.js";
import "./new-session.css";

export interface NewSessionDeps {
  loadModels(): Promise<ModelsResponse>;
  /** Rejects with an Error (often ApiClientError) whose message is shown under the form. */
  submit(request: CreateSessionRequest): Promise<void>;
}

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
    if (repo === "") {
      showError("Indica el repositorio como owner/repo.");
      repoInput.focus();
      return;
    }
    if (prompt === "") {
      showError("Escribe el prompt de la tarea.");
      promptInput.focus();
      return;
    }

    const request: CreateSessionRequest = {
      repo,
      prompt,
      mode: modeInputs.plan.checked ? "plan" : "auto",
    };
    const baseBranch = baseBranchInput.value.trim();
    if (baseBranch !== "") {
      request.baseBranch = baseBranch;
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
      on: {
        submit: (event) => {
          void handleSubmit(event);
        },
      },
    },
    field("new-session-repo", "Repositorio (owner/repo)", repoInput),
    field("new-session-base-branch", "Rama base (opcional)", baseBranchInput),
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

/** A label above a control. */
function field(id: string, label: string, control: HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "new-session-field" },
    h("label", { class: "new-session-label", attrs: { for: id }, text: label }),
    control,
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
