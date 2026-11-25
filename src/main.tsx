import "./zod-jitless";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {AppearanceProvider} from "./components/Appearance";
import {applyAppearance,cachedAppearance} from "./appearance";
import "./styles.css";
import "./appearance.css";
import "./reader.css";
import "./prepared-text.css";
import "./text-rail.css";
import "./player.css";
import "./parts/tokens.css";
import {handleSearchKey} from "./keyboard";
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
// `/` focuses the search of the page shown, the Library's or Discover's, found by its data attribute (#614); never
// while typing in a field.
window.addEventListener("keydown", handleSearchKey);
