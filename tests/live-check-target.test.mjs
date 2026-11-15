import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_URL, isProductionURL, verifyBaseURL } from "../scripts/live-check-target.mjs";

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

test("another server runs without the flag", () => {
  for (const url of ["http://127.0.0.1:4391", "http://localhost:4173", "http://127.0.0.1:5173", "https://staging.example"]) {
    assert.equal(isProductionURL(url), false, url);
    assert.equal(verifyBaseURL({ SONDER_VERIFY_URL: url }), url);
  }
});

test("every live verification script resolves its server through verifyBaseURL before it launches a browser", () => {
  const live = readdirSync(scripts).filter((name) => /^verify-.*\.mjs$/.test(name) && /SONDER_VERIFY_URL|chromium\.launch/.test(readFileSync(join(scripts, name), "utf8")));
  assert.deepEqual(live.sort(), ["verify-integrated-reader.mjs", "verify-multi-user.mjs", "verify-playback-workflow.mjs", "verify-reading-sync.mjs"]);
  for (const name of live) {
    const source = readFileSync(join(scripts, name), "utf8");
    assert.doesNotMatch(source, /SONDER_VERIFY_URL\s*\|\|/, name);
    const resolved = source.indexOf("verifyBaseURL()");
    assert.ok(resolved > 0, name);
    assert.ok(resolved < source.indexOf("chromium.launch"), `${name}: verifyBaseURL() must run before chromium.launch`);
    assert.ok(resolved > source.indexOf("loadEnvFile"), `${name}: verifyBaseURL() must run after .env is loaded`);
  }
});
