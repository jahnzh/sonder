import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {AppearanceProvider} from "./components/Appearance";
import {applyAppearance,cachedAppearance} from "./appearance";
import "./styles.css";
import "./appearance.css";
import "./reader.css";
import "./player.css";
applyAppearance(cachedAppearance());
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppearanceProvider><App /></AppearanceProvider>
  </React.StrictMode>,
);
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
// Keep the search shortcut available without intercepting typing in a field.
window.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName)
  ) {
    const search = document.querySelector<HTMLInputElement>(".topbar input");
    if (search) {
      e.preventDefault();
      search.focus();
    }
  }
});
