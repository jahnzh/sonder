import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
const temp = mkdtempSync(join(tmpdir(), "sonder-torrent-health-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
delete process.env.TRANSMISSION_RPC_URL;
const { createApp } = await import("../server/app.ts");
const { sqlite, db } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { acquire } = await import("../server/acquisitions.ts");
const { getTorrentHealth, probeTorrentHealth, resetTorrentHealth } =
  await import("../server/torrent-health.ts");
const app = await createApp();
const username = "rpc-user";
const password = "rpc-secret-password";
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
beforeEach(() => {
  resetTorrentHealth();
  delete process.env.TRANSMISSION_RPC_URL;
  delete process.env.TRANSMISSION_USERNAME;
  delete process.env.TRANSMISSION_PASSWORD;
});

type PortTest = { result: string; open?: boolean };
async function mockTransmission(
  options: { portTest?: PortTest; rejectAuth?: boolean } = {},
) {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const expected =
      "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    if (options.rejectAuth || req.headers.authorization !== expected) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    if (req.headers["x-transmission-session-id"] !== "health-session") {
      res
        .writeHead(409, { "X-Transmission-Session-Id": "health-session" })
        .end();
      return;
    }
    const body = JSON.parse(raw);
    calls.push(body.method);
    let reply: unknown = { result: "success", arguments: {} };
    if (body.method === "session-get")
      reply = {
        result: "success",
        arguments: {
          version: "4.0.5",
          "download-dir": "/downloads/complete",
          "incomplete-dir": "/downloads/incomplete",
          "incomplete-dir-enabled": false,
        },
      };
    if (body.method === "port-test") {
      const portTest = options.portTest ?? { result: "success", open: true };
      reply = {
        result: portTest.result,
        arguments:
          portTest.open === undefined ? {} : { "port-is-open": portTest.open },
      };
    }
    if (body.method === "torrent-add")
      reply = {
        result: "success",
        arguments: {
          "torrent-added": { id: 1, hashString: "d".repeat(40), name: "x" },
        },
      };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  process.env.TRANSMISSION_RPC_URL = `http://127.0.0.1:${port}/transmission/rpc`;
  process.env.TRANSMISSION_USERNAME = username;
  process.env.TRANSMISSION_PASSWORD = password;
  return { server, calls, port };
}
function close(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
}

test("reports unconfigured when no RPC URL is set", async () => {
  const health = await probeTorrentHealth();
  assert.equal(health.status, "unconfigured");
  assert.equal(health.session, false);
});

test("healthy client with an open peer port reports ok", async () => {
  const { server, calls } = await mockTransmission();
  try {
    const health = await probeTorrentHealth();
    assert.equal(health.status, "ok");
    assert.equal(health.session, true);
    assert.equal(health.network, "ok");
    assert.equal(health.version, "4.0.5");
    assert.deepEqual(calls, ["session-get", "port-test"]);
  } finally {
    await close(server);
  }
});

test("a closed peer port still counts as ok", async () => {
  const { server } = await mockTransmission({
    portTest: { result: "success", open: false },
  });
  try {
    const health = await probeTorrentHealth();
    assert.equal(health.status, "ok");
    assert.equal(health.network, "port-closed");
  } finally {
    await close(server);
  }
});

test("a failing port test means the VPN has no working connection", async () => {
  const { server } = await mockTransmission({
    portTest: { result: "Couldn't test port: No Response (0)" },
  });
  try {
    const health = await probeTorrentHealth();
    assert.equal(health.status, "offline");
    assert.equal(health.session, true);
    assert.equal(health.network, "failed");
    assert.match(health.message, /VPN/);
  } finally {
    await close(server);
  }
});

test("unreachable RPC reports unreachable", async () => {
  const { server, port } = await mockTransmission();
  await close(server);
  process.env.TRANSMISSION_RPC_URL = `http://127.0.0.1:${port}/transmission/rpc`;
  const health = await probeTorrentHealth();
  assert.equal(health.status, "unreachable");
  assert.equal(health.session, false);
  assert.equal(health.network, "unknown");
});

test("rejected credentials report auth", async () => {
  const { server } = await mockTransmission({ rejectAuth: true });
  try {
    const health = await probeTorrentHealth();
    assert.equal(health.status, "auth");
    assert.equal(health.session, false);
    assert.match(health.message, /credentials/);
  } finally {
    await close(server);
  }
});

test("health is cached and deduplicated until it expires or is forced", async () => {
  const { server, calls } = await mockTransmission();
  try {
    const [a, b] = await Promise.all([getTorrentHealth(), getTorrentHealth()]);
    assert.equal(a, b);
    assert.equal(await getTorrentHealth(), a);
    assert.equal(calls.filter((c) => c === "port-test").length, 1);
    const fresh = await getTorrentHealth(0);
    assert.notEqual(fresh, a);
    assert.equal(calls.filter((c) => c === "port-test").length, 2);
  } finally {
    await close(server);
  }
});

test("health endpoint reports status without leaking credentials or the RPC URL", async () => {
  const { server } = await mockTransmission({
    portTest: { result: "Couldn't test port: No Response (0)" },
  });
  try {
    const res = await app.inject("/api/torrents/health?fresh=1");
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "offline");
    assert.ok(!res.body.includes(password));
    assert.ok(!res.body.includes(username));
    assert.ok(!res.body.includes("127.0.0.1"));
  } finally {
    await close(server);
  }
});

test("local fallback refuses to queue a torrent while the client is offline", async () => {
  const { server, calls } = await mockTransmission({
    portTest: { result: "Couldn't test port: No Response (0)" },
  });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const hash = "e".repeat(40);
    await assert.rejects(
      acquire(`magnet:?xt=urn:btih:${hash}&dn=Offline`),
      /no internet connection through the VPN/,
    );
    assert.ok(!calls.includes("torrent-add"));
    const job = db
      .select()
      .from(s.acquisitions)
      .where(eq(s.acquisitions.hash, hash))
      .get()!;
    assert.equal(job.status, "error");
    assert.match(job.error || "", /VPN/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /fallback refused/);
    assert.ok(!warnings[0].includes(password));
  } finally {
    console.warn = warn;
    await close(server);
  }
});

test("local fallback refuses with a clear error when the client is unreachable", async () => {
  const { server, port } = await mockTransmission();
  await close(server);
  process.env.TRANSMISSION_RPC_URL = `http://127.0.0.1:${port}/transmission/rpc`;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      acquire(`magnet:?xt=urn:btih:${"f".repeat(40)}&dn=Unreachable`),
      /cannot be reached/,
    );
  } finally {
    console.warn = warn;
  }
});
