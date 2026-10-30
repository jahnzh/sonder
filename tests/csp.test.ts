import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
const temp = mkdtempSync(join(tmpdir(), "sonder-csp-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
// An auth-gated app, to prove the report endpoint needs no session.
process.env.APP_PASSWORD = "csp-test-password";
// The app serves the shell from ./dist, so run from a directory that has one.
mkdirSync(join(temp, "dist"));
writeFileSync(join(temp, "dist", "index.html"), "<!doctype html><title>shell</title>");
writeFileSync(join(temp, "dist", "sw.js"), "self.addEventListener('fetch',()=>{});");
writeFileSync(join(temp, "dist", "app.js"), "export {};");
process.chdir(temp);
const { createApp } = await import("../server/app.ts");
const { sqlite } = await import("../server/db.ts");
const { cspMode, cspPolicy, registerCsp, violationLines } = await import("../server/csp.ts");
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
async function appIn(mode?: string) {
  if (mode === undefined) delete process.env.CSP_MODE;
  else process.env.CSP_MODE = mode;
  const app = await createApp();
  apps.push(app);
  return app;
}
after(async () => {
  for (const app of apps) await app.close();
  sqlite.close();
  process.chdir(tmpdir());
  rmSync(temp, { recursive: true, force: true });
});
const ENFORCE = "content-security-policy";
const REPORT_ONLY = "content-security-policy-report-only";

test("CSP_MODE selects the mode and anything unrecognised stays report-only", () => {
  assert.equal(cspMode(undefined), "report-only");
  assert.equal(cspMode(""), "report-only");
  assert.equal(cspMode("enforce"), "enforce");
  assert.equal(cspMode(" Enforce "), "enforce");
  assert.equal(cspMode("off"), "off");
  assert.equal(cspMode("enfroce"), "report-only");
});

test("the policy has no inline-script or eval allowance and closes the document-level holes", () => {
  const policy = cspPolicy();
  const script = policy.split("; ").find((d) => d.startsWith("script-src "));
  assert.equal(script, "script-src 'self'");
  for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "connect-src 'self'", "report-uri /api/csp-report"])
    assert.ok(policy.split("; ").includes(directive), directive);
});

test("unset CSP_MODE sends the report-only header on the shell and never the enforcing one", async () => {
  const app = await appIn();
  for (const url of ["/", "/library", "/index.html"]) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 200, url);
    assert.match(String(res.headers["content-type"]), /text\/html/);
    assert.equal(res.headers[REPORT_ONLY], cspPolicy(), url);
    assert.equal(res.headers[ENFORCE], undefined, url);
  }
});

test("enforce sends Content-Security-Policy on the shell and the service worker script, not on API JSON or other assets", async () => {
  const app = await appIn("enforce");
  const shell = await app.inject({ url: "/" });
  assert.equal(shell.headers[ENFORCE], cspPolicy());
  assert.equal(shell.headers[REPORT_ONLY], undefined);
  assert.equal((await app.inject({ url: "/sw.js" })).headers[ENFORCE], cspPolicy());
  assert.equal((await app.inject({ url: "/app.js" })).headers[ENFORCE], undefined);
  const api = await app.inject({ url: "/api/health" });
  assert.equal(api.statusCode, 200);
  assert.equal(api.headers[ENFORCE], undefined);
  assert.equal(api.headers[REPORT_ONLY], undefined);
  const missing = await app.inject({ url: "/api/nothing" });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.headers[ENFORCE], undefined);
});

test("off sends no policy header", async () => {
  const app = await appIn("off");
  const res = await app.inject({ url: "/" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers[ENFORCE], undefined);
  assert.equal(res.headers[REPORT_ONLY], undefined);
});

// Real bodies as Chromium 1248 posts them for report-uri.
const legacyReport = {
  "csp-report": {
    "document-uri": "https://sonder.pecori.no/#reader?token=secret",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; script-src 'self'",
    "blocked-uri": "inline",
    "source-file": "https://sonder.pecori.no/assets/index.js?v=1#frag",
    "line-number": 3,
    disposition: "report",
  },
};
const modernReport = [
  {
    type: "csp-violation",
    url: "https://sonder.pecori.no/",
    body: { effectiveDirective: "img-src", blockedURL: "data:image/png;base64,AAAA", sourceFile: "", disposition: "report" },
  },
  { type: "deprecation", body: { id: "x" } },
];

test("violation lines name the directive, blocked URI and source file and nothing else", () => {
  assert.deepEqual(violationLines(legacyReport), [
    "csp violation: directive=script-src-elem blocked=inline source=https://sonder.pecori.no/assets/index.js",
  ]);
  assert.deepEqual(violationLines(modernReport), ["csp violation: directive=img-src blocked=data: source=-"]);
  const [line] = violationLines({ "csp-report": { "effective-directive": "x\u0001y z", "blocked-uri": "https://evil.example/a?token=1" } });
  assert.equal(line, "csp violation: directive=x?y blocked=https://evil.example/a source=-");
});

test("garbage reports are ignored without a crash", () => {
  for (const value of [null, undefined, 1, "x", [], {}, [1, null, "a"], { "csp-report": null }, { "csp-report": "x" }, { type: "csp-violation" }, { type: "csp-violation", body: 3 }])
    assert.deepEqual(violationLines(value), []);
});

test("POST /api/csp-report accepts both content types without a session and logs each violation", async () => {
  const app = Fastify();
  const lines: string[] = [];
  registerCsp(app, { mode: "report-only", report: (line) => lines.push(line) });
  const legacy = await app.inject({
    method: "POST",
    url: "/api/csp-report",
    headers: { "content-type": "application/csp-report" },
    payload: JSON.stringify(legacyReport),
  });
  assert.equal(legacy.statusCode, 204);
  const modern = await app.inject({
    method: "POST",
    url: "/api/csp-report",
    headers: { "content-type": "application/reports+json" },
    payload: JSON.stringify(modernReport),
  });
  assert.equal(modern.statusCode, 204);
  assert.equal(lines.length, 2);
  await app.close();
});

test("the report endpoint of the full app needs no sign-in or matching Origin", async () => {
  const app = await appIn("report-only");
  assert.equal((await app.inject({ url: "/api/library" })).statusCode, 401);
  const res = await app.inject({
    method: "POST",
    url: "/api/csp-report",
    headers: { "content-type": "application/csp-report", origin: "null" },
    payload: JSON.stringify(legacyReport),
  });
  assert.equal(res.statusCode, 204);
});

test("garbage, empty and wrongly typed report bodies never crash the endpoint", async () => {
  const app = Fastify();
  const lines: string[] = [];
  registerCsp(app, { mode: "report-only", report: (line) => lines.push(line) });
  const bodies: [string | undefined, string | undefined][] = [
    ["application/csp-report", "{not json"],
    ["application/csp-report", ""],
    ["application/csp-report", "null"],
    ["application/csp-report", "[[[[[[[[[[[[[[[[[[["],
    ["application/reports+json", '"a string"'],
    ["application/json", "{broken"],
    ["text/plain", "hello"],
    ["application/octet-stream", "\u0000\u0001\u0002"],
    ["multipart/form-data; boundary=x", "--x--"],
    [undefined, undefined],
  ];
  for (const [type, payload] of bodies) {
    const res = await app.inject({ method: "POST", url: "/api/csp-report", headers: type ? { "content-type": type } : {}, payload });
    assert.equal(res.statusCode, 204, `${type} ${payload}`);
  }
  assert.deepEqual(lines, []);
  await app.close();
});

test("a body over 8 KiB is refused and not logged", async () => {
  const app = Fastify();
  const lines: string[] = [];
  registerCsp(app, { mode: "report-only", report: (line) => lines.push(line) });
  const padded = JSON.stringify({ "csp-report": { "effective-directive": "img-src", "blocked-uri": "x".repeat(9000) } });
  const res = await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/csp-report" }, payload: padded });
  assert.equal(res.statusCode, 413);
  const exact = JSON.stringify({ "csp-report": { "effective-directive": "img-src", pad: "x".repeat(8192 - 60) } });
  assert.ok(exact.length <= 8192);
  assert.equal((await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/csp-report" }, payload: exact })).statusCode, 204);
  assert.deepEqual(lines.length, 1);
  await app.close();
});

test("at most 20 violations are stored per minute, and the window then reopens", async () => {
  const app = Fastify();
  const lines: string[] = [];
  let clock = 1_000_000;
  registerCsp(app, { mode: "report-only", report: (line) => lines.push(line), now: () => clock });
  const post = (n: number) =>
    app.inject({
      method: "POST",
      url: "/api/csp-report",
      headers: { "content-type": "application/csp-report" },
      payload: JSON.stringify({ "csp-report": { "effective-directive": "img-src", "blocked-uri": `https://x.example/${n}` } }),
    });
  const statuses: number[] = [];
  for (let n = 0; n < 25; n++) {
    statuses.push((await post(n)).statusCode);
    clock += 100;
  }
  assert.equal(lines.length, 20);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(204));
  assert.deepEqual(statuses.slice(20), Array(5).fill(429));
  clock += 60_000;
  assert.equal((await post(99)).statusCode, 204);
  assert.equal(lines.length, 21);
  // One body with many entries cannot exceed the limit either.
  clock += 120_000;
  const many = Array.from({ length: 30 }, (_, i) => ({ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: `https://y.example/${i}` } }));
  const res = await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/reports+json" }, payload: JSON.stringify(many) });
  assert.equal(res.statusCode, 429);
  assert.equal(lines.length, 41);
  await app.close();
});
