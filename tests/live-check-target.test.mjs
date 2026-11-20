import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as target from "../scripts/live-check-target.mjs";

const { PRODUCTION_URL, isProductionURL, verifyBaseURL } = target;

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

test("without SONDER_VERIFY_URL the default is production, which needs SONDER_VERIFY_PRODUCTION=1", () => {
  assert.throws(() => verifyBaseURL({}), /Refusing to verify against production \(https:\/\/sonder\.pecori\.no\) without SONDER_VERIFY_PRODUCTION=1/);
  assert.throws(() => verifyBaseURL({ SONDER_VERIFY_PRODUCTION: "true" }), /SONDER_VERIFY_PRODUCTION=1/);
  assert.equal(verifyBaseURL({ SONDER_VERIFY_PRODUCTION: "1" }), PRODUCTION_URL);
});

test("production by its public name or the container's loopback port is refused without the flag", () => {
  for (const url of ["https://sonder.pecori.no/", "https://sonder.pecori.no/#library", "http://127.0.0.1:3001", "http://localhost:3001/", "http://[::1]:3001"]) {
    assert.equal(isProductionURL(url), true, url);
    assert.throws(() => verifyBaseURL({ SONDER_VERIFY_URL: url }), /SONDER_VERIFY_PRODUCTION=1/, url);
    assert.equal(verifyBaseURL({ SONDER_VERIFY_URL: url, SONDER_VERIFY_PRODUCTION: "1" }), url);
  }
});

test("the local test server's own form, loopback on another port, runs without the flag", () => {
  for (const url of ["http://127.0.0.1:4391", "http://localhost:4173", "http://127.0.0.1:5173", "http://[::1]:4173", "http://LOCALHOST.:4173/", "http://127.0.0.2:4391"]) {
    assert.equal(isProductionURL(url), false, url);
    assert.equal(target.classifyTarget(url), "local-test", url);
    assert.equal(verifyBaseURL({ SONDER_VERIFY_URL: url }), url);
  }
});

// Review round 1, MEDIUM: the guard compares normalised targets.
test("production spelled another way is still production: trailing dot, case, any loopback address on 3001", () => {
  for (const url of [
    "https://sonder.pecori.no./",
    "https://SONDER.Pecori.No.",
    "https://sonder.pecori.no:443/",
    "http://sonder.pecori.no:3001",
    "https://user:pass@sonder.pecori.no./#library",
    "http://127.0.0.2:3001",
    "http://127.255.255.254:3001",
    "http://2130706433:3001",
    "http://127.1:3001",
    "http://0.0.0.0:3001",
    "http://[::ffff:127.0.0.1]:3001",
    "http://[0:0:0:0:0:0:0:1]:3001",
    "http://[::]:3001",
    "http://LocalHost.:3001",
    "http://sonder.localhost:3001",
  ]) {
    assert.equal(target.classifyTarget(url), "production", url);
    assert.throws(() => verifyBaseURL({ SONDER_VERIFY_URL: url }), /Refusing to verify against production .* without SONDER_VERIFY_PRODUCTION=1/, url);
    assert.equal(verifyBaseURL({ SONDER_VERIFY_URL: url, SONDER_VERIFY_PRODUCTION: "1" }), url);
  }
});

test("every address in the one production list is refused, normalised the same way", () => {
  assert.deepEqual(target.PRODUCTION_HOSTS, ["sonder.pecori.no"]);
  // List entries go through the same normalising as URLs, so an entry written as "Sonder.Pecori.NO." still matches.
  assert.equal(target.normalHost("Sonder.Pecori.NO."), "sonder.pecori.no");
  assert.equal(target.normalHost("[::1]"), "::1");
  for (const host of target.PRODUCTION_HOSTS)
    for (const spelling of [host, host.toUpperCase(), `${host}.`])
      for (const url of [`https://${spelling}`, `http://${spelling}:8080/x`]) assert.equal(target.classifyTarget(url), "production", url);
});

test("a URL the guard cannot classify is refused without the flag (a LAN address, another host, garbage)", () => {
  for (const url of ["http://192.168.1.20:3001", "http://192.168.1.119:4173", "https://staging.example", "http://sonder:3001", "ftp://127.0.0.1:21", "not a url", "http://"]) {
    assert.equal(target.classifyTarget(url), "unknown", url);
    assert.throws(() => verifyBaseURL({ SONDER_VERIFY_URL: url }), /without SONDER_VERIFY_PRODUCTION=1: it is not a local test server/, url);
    assert.equal(verifyBaseURL({ SONDER_VERIFY_URL: url, SONDER_VERIFY_PRODUCTION: "1" }), url);
  }
});

test("every live verification script resolves its server through verifyBaseURL before it launches a browser", () => {
  const live = readdirSync(scripts).filter((name) => /^verify-.*\.mjs$/.test(name) && /SONDER_VERIFY_URL|chromium\.launch/.test(readFileSync(join(scripts, name), "utf8")));
  assert.deepEqual(live.sort(), ["verify-integrated-reader.mjs", "verify-multi-user.mjs", "verify-playback-workflow.mjs", "verify-reading-sync.mjs", "verify-slice-pass.mjs"]);
  for (const name of live) {
    const source = readFileSync(join(scripts, name), "utf8");
    assert.doesNotMatch(source, /SONDER_VERIFY_URL\s*\|\|/, name);
    const resolved = source.indexOf("verifyBaseURL()");
    assert.ok(resolved > 0, name);
    assert.ok(resolved < source.indexOf("chromium.launch"), `${name}: verifyBaseURL() must run before chromium.launch`);
    assert.ok(resolved > source.indexOf("loadEnvFile"), `${name}: verifyBaseURL() must run after .env is loaded`);
  }
});
