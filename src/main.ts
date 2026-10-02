import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
import "./ui/styles/tokens.css";
import "./ui/styles/app.css";
import { startApp } from "./app/App";

const root = document.getElementById("app");
if (root) {
  startApp(root, { version: __VERA_VERSION__, commit: __VERA_COMMIT__ });
}
