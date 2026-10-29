import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BidiRelay, EMULATOR_PREFS, geckoViewConfig, readUserPrefs, startCommand } from "./android/firefox-android.mjs";
import { screenSizeFor } from "./android/viewport";
import { androidBrowser } from "./android/fixtures";

const { yaml } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");

test("user.js prefs are read as strings, numbers and booleans", () => {
  const prefs = readUserPrefs(
    [
      'user_pref("app.normandy.api_url", "");',
      'user_pref("apz.content_response_timeout", 60000);',
      'user_pref("browser.dom.window.dump.enabled", true);',
      'user_pref("quoted \\"name\\"", "a \\"b\\"");',
      "// a comment",
      "user_pref(broken);",
    ].join("\n"),
  );
  assert.deepEqual(prefs, {
    "app.normandy.api_url": "",
    "apz.content_response_timeout": 60000,
    "browser.dom.window.dump.enabled": true,
    'quoted "name"': 'a "b"',
  });
});

test("the GeckoView config enables the remote agent on the given port with the prefs", () => {
  const config = yaml.parse(geckoViewConfig({ port: 19222, prefs: { ...EMULATOR_PREFS, "a.b": "c" } }));
  // The agent answers 400 to a Host header with another port, so the port is the one clients use.
  assert.deepEqual(config.args, ["--remote-debugging-port", "19222", "--remote-allow-hosts", "localhost,127.0.0.1"]);
  assert.equal(config.prefs["a.b"], "c");
  assert.equal(config.prefs["layers.gpu-process.enabled"], false);
  assert.equal(config.prefs["gfx.webrender.software"], true);
});

test("the start command opens a tab on the URL and skips onboarding", () => {
  assert.equal(
    startCommand("http://127.0.0.1:4174/api/health"),
    "am start -n org.mozilla.firefox/org.mozilla.fenix.IntentReceiverActivity -a android.intent.action.VIEW -d http://127.0.0.1:4174/api/health --ez performancetest true",
  );
  for (const url of ["about:blank", "http://x/; reboot", "http://x/$(id)", "file:///etc/passwd"]) {
    assert.throws(() => startCommand(url), /Unexpected start URL/);
  }
});

const session = (id: number) => JSON.stringify({ type: "success", id, result: { sessionId: "s", capabilities: {} } });
const parse = (messages: string[]) => messages.map((message) => JSON.parse(message));

test("the relay passes unscoped and other messages through unchanged", () => {
  const relay = new BidiRelay();
  const message = JSON.stringify({ id: 1, method: "browsingContext.navigate", params: { context: "c", url: "http://x/" } });
  assert.deepEqual(relay.fromClient(message), { toBrowser: [message], toClient: [], notes: [], close: false });
  assert.deepEqual(relay.fromClient("not json").toBrowser, ["not json"]);
  const event = JSON.stringify({ type: "event", method: "log.entryAdded", params: {} });
  assert.deepEqual(relay.fromBrowser(event).toClient, [event]);
});

test("the relay sends browser.setDownloadBehavior for the default user context unscoped", () => {
  const relay = new BidiRelay();
  const out = relay.fromClient(JSON.stringify({ id: 4, method: "browser.setDownloadBehavior", params: { downloadBehavior: { type: "denied" }, userContexts: ["default"] } }));
  assert.deepEqual(parse(out.toBrowser), [{ id: 4, method: "browser.setDownloadBehavior", params: { downloadBehavior: { type: "denied" } } }]);
  assert.equal(out.toClient.length, 0);
  // Another user context is left alone: only "default" is known to be equivalent to no scope.
  const other = JSON.stringify({ id: 5, method: "browser.setDownloadBehavior", params: { downloadBehavior: { type: "denied" }, userContexts: ["uc-1"] } });
  assert.deepEqual(relay.fromClient(other).toBrowser, [other]);
});

test("the relay applies default-user-context emulation to every top-level context, now and later", () => {
  const relay = new BidiRelay();
  // After session.new the relay asks for the contexts that already exist.
  const learn = relay.fromBrowser(session(1));
  const getTree = parse(learn.toBrowser)[0];
  assert.equal(getTree.method, "browsingContext.getTree");
  assert.ok(getTree.id >= 1_000_000_000);
  // Its answer is not passed to the client.
  const tree = relay.fromBrowser(JSON.stringify({ type: "success", id: getTree.id, result: { contexts: [{ context: "tab-1", children: [] }] } }));
  assert.deepEqual(tree.toClient, []);

  const offline = relay.fromClient(JSON.stringify({ id: 7, method: "emulation.setNetworkConditions", params: { networkConditions: { type: "offline" }, userContexts: ["default"] } }));
  assert.deepEqual(parse(offline.toBrowser), [{ id: 7, method: "emulation.setNetworkConditions", params: { networkConditions: { type: "offline" }, contexts: ["tab-1"] } }]);

  // A tab opened later gets the same emulation from the relay, and the client still sees the event.
  const created = JSON.stringify({ type: "event", method: "browsingContext.contextCreated", params: { context: "tab-2", parent: null } });
  const later = relay.fromBrowser(created);
  assert.deepEqual(later.toClient, [created]);
  const [replay] = parse(later.toBrowser);
  assert.equal(replay.method, "emulation.setNetworkConditions");
  assert.deepEqual(replay.params, { networkConditions: { type: "offline" }, contexts: ["tab-2"] });
  // A frame inside a tab is not a top-level context.
  const frame = relay.fromBrowser(JSON.stringify({ type: "event", method: "browsingContext.contextCreated", params: { context: "frame-1", parent: "tab-2" } }));
  assert.deepEqual(frame.toBrowser, []);
  // A failing relay command is noted, not passed on.
  const failed = relay.fromBrowser(JSON.stringify({ type: "error", id: replay.id, error: "unknown error", message: "x" }));
  assert.deepEqual(failed.toClient, []);
  assert.match(failed.notes[0], /failed: unknown error/);
});

test("emulation before any tab exists is answered and applied to the first tab", () => {
  const relay = new BidiRelay();
  const out = relay.fromClient(JSON.stringify({ id: 3, method: "emulation.setLocaleOverride", params: { locale: "en-US", userContexts: ["default"] } }));
  assert.deepEqual(out.toBrowser, []);
  assert.deepEqual(parse(out.toClient), [{ type: "success", id: 3, result: {} }]);
  const first = relay.fromBrowser(JSON.stringify({ type: "event", method: "browsingContext.contextCreated", params: { context: "tab-1" } }));
  assert.deepEqual(parse(first.toBrowser)[0].params, { locale: "en-US", contexts: ["tab-1"] });
});

test("browser.close is answered by the relay, which then closes the app", () => {
  const out = new BidiRelay().fromClient(JSON.stringify({ id: 9, method: "browser.close", params: {} }));
  assert.equal(out.close, true);
  assert.deepEqual(out.toBrowser, []);
  assert.deepEqual(parse(out.toClient), [{ type: "success", id: 9, result: {} }]);
});

test("a CSS viewport maps to a screen size with the browser's toolbars added", () => {
  assert.deepEqual(screenSizeFor({ width: 390, height: 844 }, 2, 80), { width: 780, height: 1848 });
  assert.deepEqual(screenSizeFor({ width: 1280, height: 800 }, 2, 88), { width: 2560, height: 1776 });
  assert.deepEqual(screenSizeFor({ width: 360, height: 740 }, 2.625, 80), { width: 945, height: 2153 });
});

test("SONDER_ANDROID_BROWSER selects chrome or firefox and rejects anything else", () => {
  assert.equal(androidBrowser({}), undefined);
  assert.equal(androidBrowser({ SONDER_ANDROID_BROWSER: "chrome" }), "chrome");
  assert.equal(androidBrowser({ SONDER_ANDROID_BROWSER: "firefox" }), "firefox");
  assert.throws(() => androidBrowser({ SONDER_ANDROID_BROWSER: "safari" }), /chrome or firefox/);
});
