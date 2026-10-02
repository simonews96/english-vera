import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
import "./ui/styles/tokens.css";
import "./ui/styles/app.css";

// Placeholder bootstrap: replaced by the real app wiring in src/app/.
const root = document.getElementById("app");
if (root) {
  root.innerHTML = `<p class="label">Vera</p><p class="it">Il telaio si sta preparando.</p>`;
}
