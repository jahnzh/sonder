import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tempDir } from "./temp-dir.ts";

// AudioBookBay requests through ABB_PROXY_URL (#755): a real mirror and a real CONNECT proxy on loopback.
const temp = tempDir("sonder-abb-proxy-");
process.env.DATA_DIR = join(temp, "db");
const { db } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { abbReleaseSearch, abbMagnet } = await import("../server/services.ts");

const hash = "a".repeat(40);
const mirror = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(
    req.url?.startsWith("/abss/")
      ? `<div class="postContent"><a href="magnet:?xt=urn:btih:${hash}">Magnet</a></div>`
      : `<div class="post"><div class="postTitle"><h2><a href="/abss/the-state-of-the-art/">The State of the Art - Iain M. Banks</a></h2></div><div class="postInfo">Language: English</div><div class="postContent">Format: MP3</div></div>`,
  );
});
const tunnels: string[] = [];
const proxy = createServer((_req, res) => res.writeHead(405).end());
proxy.on("connect", (req, socket, head) => {
  tunnels.push(req.url ?? "");
  const [host, port] = (req.url ?? "").split(":");
  const upstream = connect(Number(port), host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const mirrorPort = await listen(mirror);
const proxyPort = await listen(proxy);
const setMirror = (url: string) =>
  db.insert(s.settings).values({ key: "abbUrl", value: url }).onConflictDoUpdate({ target: s.settings.key, set: { value: url } }).run();

after(() => {
  delete process.env.ABB_PROXY_URL;
  mirror.closeAllConnections();
  proxy.closeAllConnections();
  mirror.close();
  proxy.close();
});

test("without ABB_PROXY_URL the mirror is asked directly", async () => {
  delete process.env.ABB_PROXY_URL;
  setMirror(`http://127.0.0.1:${mirrorPort}`);
  const found = await abbReleaseSearch("The State of the Art");
  assert.equal(found.results[0]?.title, "The State of the Art");
  assert.deepEqual(tunnels, []);
});

test("with ABB_PROXY_URL the search and the magnet request go through the proxy", async () => {
  process.env.ABB_PROXY_URL = `http://127.0.0.1:${proxyPort}`;
  setMirror(`http://127.0.0.1:${mirrorPort}`);
  const found = await abbReleaseSearch("The State of the Art");
  assert.equal(found.results[0]?.id, "the-state-of-the-art");
  assert.equal(await abbMagnet("the-state-of-the-art"), `magnet:?xt=urn:btih:${hash}`);
  assert.ok(tunnels.length >= 1);
  assert.ok(tunnels.every((target) => target === `127.0.0.1:${mirrorPort}`));
});

test("a mirror that cannot be reached says so instead of 'fetch failed'", async () => {
  delete process.env.ABB_PROXY_URL;
  const closed = createServer();
  const port = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  setMirror(`http://127.0.0.1:${port}`);
  await assert.rejects(abbReleaseSearch("banks"), /The mirror could not be reached\./);
});

test("a proxy that cannot be reached is named in the sentence", async () => {
  const closed = createServer();
  const port = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  process.env.ABB_PROXY_URL = `http://127.0.0.1:${port}`;
  setMirror(`http://127.0.0.1:${mirrorPort}`);
  await assert.rejects(abbReleaseSearch("banks"), /could not be reached through the server's proxy\./);
  process.env.ABB_PROXY_URL = "not a url";
  await assert.rejects(abbReleaseSearch("banks"), /could not be reached through the server's proxy\./);
});
