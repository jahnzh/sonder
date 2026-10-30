#!/usr/bin/env node
// Stands in for the Firefox binary when Playwright launches `firefox` with a `moz-*` channel
// (WebDriver BiDi) and this file as executablePath (issue #66). Instead of starting a desktop
// Firefox it starts Firefox for Android on the emulator with its remote agent enabled, relays
// Playwright's BiDi connection to it, and prints the line Playwright waits for:
//   WebDriver BiDi listening on ws://127.0.0.1:<relay port>
// Playwright's arguments (--remote-debugging-port=0, --headless, --profile <dir>) are read only
// for the profile's user.js, whose prefs go into the GeckoView config.
//
// Environment: SONDER_ANDROID_START_URL (required, the first tab's URL), SONDER_ANDROID_ADB_HOST and
// SONDER_ANDROID_ADB_PORT (the adb server, default 127.0.0.1:15037), SONDER_ANDROID_BIDI_PORT (default
// 19222: forwarded from here to the same port on the device), SONDER_ANDROID_LOG (a file for notes).
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { WebSocket, WebSocketServer } from "ws";
import { BidiRelay, EMULATOR_PREFS, FIREFOX_PACKAGE, geckoViewConfig, readUserPrefs, startCommand } from "./firefox-android.mjs";

const require = createRequire(import.meta.url);
const { _android } = require("playwright-core");

const adbHost = process.env.SONDER_ANDROID_ADB_HOST || "127.0.0.1";
const adbPort = Number(process.env.SONDER_ANDROID_ADB_PORT || 15037);
const bidiPort = Number(process.env.SONDER_ANDROID_BIDI_PORT || 19222);
const startUrl = process.env.SONDER_ANDROID_START_URL;
const note = (text) => {
  if (process.env.SONDER_ANDROID_LOG) appendFileSync(process.env.SONDER_ANDROID_LOG, `${new Date().toISOString()} ${text}\n`);
};
const fail = (text) => {
  process.stderr.write(`[firefox-android] ${text}\n`);
  note(`fail: ${text}`);
  process.exit(1);
};
if (!startUrl) fail("SONDER_ANDROID_START_URL is not set");

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
let prefs = {};
if (profileIndex >= 0) {
  try {
    prefs = readUserPrefs(readFileSync(`${args[profileIndex + 1]}/user.js`, "utf8"));
  } catch {
    // No user.js: start with Firefox's defaults.
  }
}

const devices = await _android.devices({ host: adbHost, port: adbPort, omitDriverInstall: true }).catch((error) => fail(`adb: ${error.message}`));
if (!devices.length) fail(`no device on the adb server at ${adbHost}:${adbPort}`);
const device = devices[0];
const shell = async (command) => (await device.shell(command)).toString().trim();

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  try {
    await shell(`am force-stop ${FIREFOX_PACKAGE}`);
    await shell("am clear-debug-app");
    await shell(`rm -f /data/local/tmp/${FIREFOX_PACKAGE}-geckoview-config.yaml`);
  } catch {
    // The emulator may already be gone; the test script stops it anyway.
  }
  await device.close().catch(() => {});
  process.exit(code);
}
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));

// A fresh profile for every launch, as Playwright gives a desktop browser.
await shell(`am force-stop ${FIREFOX_PACKAGE}`);
await shell(`pm clear ${FIREFOX_PACKAGE}`);
await device.push(Buffer.from(geckoViewConfig({ port: bidiPort, prefs: { ...prefs, ...EMULATOR_PREFS } })), `/data/local/tmp/${FIREFOX_PACKAGE}-geckoview-config.yaml`);
await shell(`am set-debug-app --persistent ${FIREFOX_PACKAGE}`);
// Starting right after `pm clear` can race the task removal and never launch.
await new Promise((resolve) => setTimeout(resolve, 1500));
note(await shell(startCommand(startUrl)));

const upstreamBase = `127.0.0.1:${bidiPort}`;
const deadline = Date.now() + 60_000;
for (;;) {
  // Any HTTP answer (the agent's root path answers 400) means the remote agent is listening.
  const up = await fetch(`http://${upstreamBase}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  if (up) break;
  if (Date.now() > deadline) {
    await stop(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", (client, request) => {
  const relay = new BidiRelay();
  const upstream = new WebSocket(`ws://${upstreamBase}${request.url}`, { perMessageDeflate: false });
  const queue = [];
  const toBrowser = (message) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
    else queue.push(message);
  };
  const apply = (out) => {
    for (const text of out.notes) note(text);
    for (const message of out.toClient) client.send(message);
    for (const message of out.toBrowser) toBrowser(message);
  };
  upstream.on("open", () => {
    for (const message of queue.splice(0)) upstream.send(message);
  });
  upstream.on("message", (data) => apply(relay.fromBrowser(data.toString())));
  upstream.on("close", () => client.close());
  upstream.on("error", (error) => {
    note(`upstream error: ${error.message}`);
    client.close();
  });
  client.on("message", (data) => {
    const out = relay.fromClient(data.toString());
    apply(out);
    if (out.close) {
      setTimeout(() => {
        client.close();
        upstream.close();
        void stop(0);
      }, 100);
    }
  });
  client.on("close", () => upstream.close());
});
await new Promise((resolve) => server.on("listening", resolve));
process.stderr.write(`WebDriver BiDi listening on ws://127.0.0.1:${server.address().port}\n`);

// The app can die (a crash, or the emulator going away); report that as the browser exiting.
setInterval(async () => {
  const pid = await shell(`pidof ${FIREFOX_PACKAGE}`).catch(() => "");
  if (!pid && !stopping) {
    note("the app is no longer running");
    await stop(1);
  }
}, 2000);
