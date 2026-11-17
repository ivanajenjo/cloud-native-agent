import "./styles.css";
import { h } from "./dom.js";

// Provisional: replaced by the definitive entry point in a later task.
const app = document.getElementById("app");
if (!app) {
  throw new Error('missing element "#app"');
}
app.replaceChildren(h("p", { text: "cna" }));
