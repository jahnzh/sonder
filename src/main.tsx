import "./zod-jitless";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {AppearanceProvider} from "./components/Appearance";
import {applyAppearance,cachedAppearance} from "./appearance";
import "./styles.css";
import "./appearance.css";
import "./reader.css";
import "./player.css";
import "./parts/tokens.css";
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
// Keep the search shortcut available without intercepting typing in a field: "/" focuses the Library's search field
// where it is shown (the top bar and its field went with #581).
window.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName)
  ) {
    const search = document.querySelector<HTMLInputElement>('.library-search input[aria-label="Search your library"]');
    if (search) {
      e.preventDefault();
      search.focus();
    }
  }
});
