// Pure helpers for driving Firefox for Android through WebDriver BiDi (issue #66). The launcher
// (firefox-bidi-launcher.mjs) uses them; tests/android-emulator.test.ts covers them.

export const FIREFOX_PACKAGE = "org.mozilla.firefox";
// The activity geckodriver starts for Fenix builds; it accepts VIEW intents.
export const FIREFOX_ACTIVITY = "org.mozilla.fenix.IntentReceiverActivity";

// Reads the user_pref(...) lines Playwright writes to <profile>/user.js.
export function readUserPrefs(text) {
  const prefs = {};
  for (const match of text.matchAll(/^\s*user_pref\(\s*("(?:[^"\\]|\\.)*")\s*,\s*(.+?)\s*\);\s*$/gm)) {
    try {
      prefs[JSON.parse(match[1])] = JSON.parse(match[2]);
    } catch {
      // Not a JSON literal (Playwright only writes strings, numbers and booleans); skip it.
    }
  }
  return prefs;
}

// Prefs added to Playwright's for the emulator. Its GLES is SwiftShader: Firefox's GPU process then
// times out on a screen resize ("Killing GPU process due to IPC reply timeout") and crash-loops, so
// rendering stays in software in the main process. Crash reports are not sent from test runs.
export const EMULATOR_PREFS = {
  "layers.gpu-process.enabled": false,
  "gfx.webrender.software": true,
  "browser.crashReports.unsubmittedCheck.autoSubmit2": false,
  "toolkit.telemetry.enabled": false,
  "datareporting.healthreport.uploadEnabled": false,
};

// GeckoView reads /data/local/tmp/<package>-geckoview-config.yaml at start when the app is the
// selected debug app. The remote agent's HTTP server answers 400 to any Host header whose port is
// not its own, so the device port must be the port the client connects to.
export function geckoViewConfig({ port, prefs }) {
  const lines = [
    "# Written by tests/android/firefox-bidi-launcher.mjs for one test run.",
    "args:",
    '  - "--remote-debugging-port"',
    `  - "${port}"`,
    '  - "--remote-allow-hosts"',
    '  - "localhost,127.0.0.1"',
    "prefs:",
  ];
  for (const [name, value] of Object.entries(prefs)) lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  return lines.join("\n") + "\n";
}

// The `am start` command that opens Firefox on a tab: the remote agent waits for an initial
// application window, and Fenix opens none without a VIEW intent. The performancetest extra makes
// Fenix skip onboarding when adb is enabled and the device is charging, as the emulator always is.
export function startCommand(url) {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]/_?&=%-]*$/.test(url)) throw new Error(`Unexpected start URL: ${url}`);
  return `am start -n ${FIREFOX_PACKAGE}/${FIREFOX_ACTIVITY} -a android.intent.action.VIEW -d ${url} --ez performancetest true`;
}

// The BiDi relay between Playwright and Firefox for Android. Firefox for Android 159 differs from
// desktop in two places Playwright uses:
// - A command scoped to userContexts ["default"] throws "tab.hasAttribute is not a function".
//   Pages exist only in the default user context on Android. A command that may be unscoped
//   (browser.setDownloadBehavior) is sent unscoped, which has the same effect. emulation.* commands
//   must be scoped, so the relay sends them to every current top-level browsing context and again
//   to each one created later, which is what the user-context scope means.
// - browser.close is closing the app; the launcher does that itself (force-stop) and answers.
// fromClient and fromBrowser take one message and return what to send each way.
export class BidiRelay {
  constructor() {
    this.topLevel = new Set();
    this.scoped = new Map();
    this.internal = new Set();
    this.nextId = 1_000_000_000;
  }

  #internal(method, params) {
    const id = this.nextId++;
    this.internal.add(id);
    return JSON.stringify({ id, method, params });
  }

  fromClient(text) {
    const out = { toBrowser: [], toClient: [], notes: [], close: false };
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      out.toBrowser.push(text);
      return out;
    }
    if (message.method === "browser.close") {
      out.toClient.push(JSON.stringify({ type: "success", id: message.id, result: {} }));
      out.close = true;
      out.notes.push("browser.close: answered by the launcher, which force-stops the app");
      return out;
    }
    const userContexts = message.params?.userContexts;
    if (!(Array.isArray(userContexts) && userContexts.length === 1 && userContexts[0] === "default")) {
      out.toBrowser.push(text);
      return out;
    }
    const { userContexts: _, ...params } = message.params;
    if (!message.method.startsWith("emulation.")) {
      out.toBrowser.push(JSON.stringify({ ...message, params }));
      out.notes.push(`${message.method}: sent without userContexts ["default"]`);
      return out;
    }
    this.scoped.set(message.method, params);
    if (this.topLevel.size === 0) {
      // Nothing open yet: it applies to the contexts created from now on.
      out.toClient.push(JSON.stringify({ type: "success", id: message.id, result: {} }));
      out.notes.push(`${message.method}: no top-level context yet; applied to new ones`);
      return out;
    }
    out.toBrowser.push(JSON.stringify({ ...message, params: { ...params, contexts: [...this.topLevel] } }));
    out.notes.push(`${message.method}: sent to ${this.topLevel.size} top-level context(s) instead of userContexts ["default"]`);
    return out;
  }

  fromBrowser(text) {
    const out = { toBrowser: [], toClient: [], notes: [] };
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      out.toClient.push(text);
      return out;
    }
    if (this.internal.has(message.id)) {
      this.internal.delete(message.id);
      if (message.type === "error") out.notes.push(`relay command ${message.id} failed: ${message.error}: ${message.message}`);
      for (const context of message.result?.contexts ?? []) this.#addTopLevel(context.context, out);
      return out;
    }
    if (message.type === "success" && message.result?.sessionId && message.result?.capabilities) {
      // The session exists now: learn the contexts that were open before Playwright subscribed.
      out.toBrowser.push(this.#internal("browsingContext.getTree", { maxDepth: 0 }));
    }
    if (message.method === "browsingContext.contextCreated" && !message.params.parent) this.#addTopLevel(message.params.context, out);
    if (message.method === "browsingContext.contextDestroyed") this.topLevel.delete(message.params.context);
    out.toClient.push(text);
    return out;
  }

  // A top-level context gets every user-context-scoped emulation sent so far.
  #addTopLevel(context, out) {
    if (this.topLevel.has(context)) return;
    this.topLevel.add(context);
    for (const [method, params] of this.scoped) out.toBrowser.push(this.#internal(method, { ...params, contexts: [context] }));
  }
}
