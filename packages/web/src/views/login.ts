import { h } from "../dom.js";
import "./login.css";

/** Token form. `message` (e.g. "Token no válido") is shown above the form when given. */
export function createLoginView(
  onSubmit: (token: string, remember: boolean) => void,
  message?: string,
): HTMLElement {
  const tokenInput = h("input", {
    class: "login-input",
    attrs: {
      id: "login-token",
      type: "password",
      autocomplete: "off",
      required: true,
      "aria-describedby": "login-help",
    },
  });
  const rememberInput = h("input", {
    attrs: { id: "login-remember", type: "checkbox" },
  });

  const form = h(
    "form",
    {
      class: "login-form",
      on: {
        submit: (event) => {
          event.preventDefault();
          const token = tokenInput.value.trim();
          if (token === "") {
            tokenInput.focus();
            return;
          }
          onSubmit(token, rememberInput.checked);
        },
      },
    },
    h("label", { class: "login-label", attrs: { for: "login-token" }, text: "Token de acceso" }),
    tokenInput,
    h("p", {
      class: "login-help",
      attrs: { id: "login-help" },
      text: "Es el AGENT_API_TOKEN de edge.",
    }),
    h(
      "div",
      { class: "login-remember" },
      rememberInput,
      h("label", { attrs: { for: "login-remember" }, text: "Recordar en este navegador" }),
    ),
    h("button", { class: "login-submit", attrs: { type: "submit" }, text: "Entrar" }),
  );

  return h(
    "section",
    { class: "login" },
    h("h1", { class: "login-title", text: "cna" }),
    message
      ? h("p", { class: "login-message", attrs: { role: "alert" }, text: message })
      : undefined,
    form,
  );
}
