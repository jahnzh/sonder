// scripts/prepare-library.sh against a small stand-in for the server (#858): it signs in once however many times
// it asks, and a refused sign-in or request is reported as that, never as an unprepared library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/prepare-library.sh");
const state = (current, running, extra = {}) => ({ ahead: true, running, book: null, editions: 4, current, missing: 0, failed: [], waiting: 0, full: false, ...extra });

/**
 * A server that answers the three routes the command uses. `states` are the answers to the status question in turn
 * (the last one for good); an entry that is a number is answered with that HTTP status instead. `loginStatus`: what
 * each sign-in is answered with, in turn.
 */
async function standIn({ states, loginStatus = [200], backfillStatus = 200, sessionsDie = 0 } = {}) {
  const seen = { logins: 0, backfills: 0, asked: 0, unauthorised: 0, cookies: new Set() };
  let session = 0;
  const server = createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/auth/login") {
      const status = loginStatus[Math.min(seen.logins, loginStatus.length - 1)];
      seen.logins++;
      if (status !== 200) return json(status, { error: "Too many sign-in attempts." });
      session++;
      res.writeHead(200, { "content-type": "application/json", "set-cookie": `sonder_session=s${session}; Path=/; HttpOnly` });
      return res.end("{}");
    }
    const cookie = /sonder_session=(s\d+)/.exec(req.headers.cookie || "")?.[1];
    if (cookie !== `s${session}` || (sessionsDie > 0 && seen.asked === sessionsDie && cookie === "s1")) {
      // The server restarted and no longer knows the session.
      if (cookie === "s1" && sessionsDie > 0) session = 99;
      seen.unauthorised++;
      return json(401, { error: "Sign in to your listening space." });
    }
    seen.cookies.add(cookie);
    if (req.url === "/api/prepared-text/backfill" && req.method === "POST") {
      seen.backfills++;
      return backfillStatus === 200 ? json(200, states[0]) : json(backfillStatus, { error: "Rate limit exceeded" });
    }
    if (req.url === "/api/prepared-text") {
      const answer = states[Math.min(seen.asked + 1, states.length - 1)];
      seen.asked++;
      return typeof answer === "number" ? json(answer, { error: "Rate limit exceeded" }) : json(200, answer);
    }
    json(404, { error: "Not found" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}
async function run(server, args = [], env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sonder-prepare-test-"));
  writeFileSync(join(dir, "env"), "APP_PASSWORD=stand-in-password\n");
  try {
    return await new Promise((done) => {
      const child = spawn("bash", [script, ...args], {
        env: { ...process.env, SONDER_ADMIN_URL: server.url, SONDER_ENV_FILE: join(dir, "env"), SONDER_PREPARE_POLL: "0.05", TMPDIR: dir, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => done({ status, stdout, stderr, left: readdirSync(dir).filter((name) => name !== "env") }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
}

test("one sign-in for the whole run, however many times the state is asked", async () => {
  // Fourteen questions before the sweep is through: more than the ten sign-ins the server allows in 15 minutes.
  const states = [state(0, true), ...Array.from({ length: 13 }, (_item, index) => state(Math.min(4, Math.floor(index / 3)), true)), state(4, false)];
  const server = await standIn({ states });
  const result = await run(server);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(server.seen.logins, 1, "signed in once");
  assert.equal(server.seen.backfills, 1);
  assert.equal(server.seen.asked, 14);
  assert.deepEqual([...server.seen.cookies], ["s1"], "every request carried that one session");
  assert.match(result.stdout, /prepare-library: 0 of 4 editions prepared\n(?:.*\n)*prepare-library: 4 of 4 editions prepared\n$/);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.left, [], "the session's folder is removed");
});

test("a refused sign-in is said as that, with its own exit code, and not as an unprepared library", async () => {
  const server = await standIn({ states: [state(0, true)], loginStatus: [429] });
  const result = await run(server);
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /Sign-in refused \(HTTP 429\): too many sign-ins from this address/);
  assert.match(result.stderr, /prepare-library: COULD NOT ASK THE SERVER: the sign-in was refused, too many sign-ins from this address \(HTTP 429\)/);
  assert.match(result.stderr, /this says nothing about the library/);
  assert.doesNotMatch(result.stdout + result.stderr, /could not prepare|editions prepared/);
  assert.deepEqual([server.seen.logins, server.seen.backfills], [1, 0]);
  assert.deepEqual(result.left, []);
});

test("too many requests while it waits is said, asked again, and the run goes on to the real answer", async () => {
  const server = await standIn({ states: [state(1, true), state(2, true), 429, 429, state(3, true), state(4, false)] });
  const result = await run(server);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr.split("\n").filter((line) => /the server answered HTTP 429 \(too many requests\) to the question; asking again/.test(line)).length, 2);
  assert.match(result.stdout, /prepare-library: 4 of 4 editions prepared\n$/);
  assert.equal(server.seen.logins, 1);
});

test("a server that keeps refusing ends the run as 'could not ask', never as a failed library", async () => {
  const server = await standIn({ states: [state(1, true), 429] });
  const result = await run(server);
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stderr, /COULD NOT ASK THE SERVER: six answers in a row were no state of the library \(last: HTTP 429\)/);
  assert.doesNotMatch(result.stderr, /could not prepare/);
  const refused = await standIn({ states: [state(0, true)], backfillStatus: 429 });
  const start = await run(refused);
  assert.equal(start.status, 3, start.stderr + start.stdout);
  assert.match(start.stderr, /COULD NOT ASK THE SERVER: starting the sweep answered HTTP 429 \(too many requests\)/);
});

test("a book that could not be prepared is still exit 1 with its name, and a session the server forgot is renewed once", async () => {
  const failed = await standIn({ states: [state(0, true), state(3, false, { failed: [{ id: "bad-book", error: "This EPUB could not be opened." }] })] });
  const result = await run(failed);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /prepare-library: could not prepare:\nbad-book: This EPUB could not be opened\./);
  // The server restarts while the command waits: the next question is refused, the command signs in once more.
  const restarted = await standIn({ states: [state(0, true), state(1, true), state(2, true), state(4, false)], sessionsDie: 1 });
  const again = await run(restarted);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(restarted.seen.logins, 2, "one sign-in, and one more after the server forgot the session");
  assert.match(again.stdout, /prepare-library: 4 of 4 editions prepared\n$/);
});

test("--no-wait starts the sweep, says the state once and signs in once", async () => {
  const server = await standIn({ states: [state(1, true), state(4, false)] });
  const result = await run(server, ["--no-wait"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stdout, "prepare-library: 1 of 4 editions prepared\n");
  assert.deepEqual([server.seen.logins, server.seen.backfills, server.seen.asked], [1, 1, 0]);
});
