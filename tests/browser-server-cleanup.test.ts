// The browser test server removes its own temp directory when it stops (test leftovers): each run used
// to leave a 0.3-1 GB /tmp/sonder-browser-* behind because Playwright SIGKILLed it. The server is started
// the way Playwright's webServer starts it (a shell command in its own process group, stopped by a
// signal to the group), with TMPDIR pointing at a directory this test owns.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../playwright.config.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bases: string[] = [];
after(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true });
});

function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolvePort(port));
    });
  });
}

function serverDirs(base: string) {
  return readdirSync(base).filter((name) => name.startsWith("sonder-browser-"));
}

function startServer(base: string, port: number, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: base, PLAYWRIGHT_PORT: String(port), ...extraEnv };
  for (const key of ["SONDER_BROWSER_TEMP", "PLAYWRIGHT_DATA_DIR", "SONDER_KEEP_BROWSER_TEMP"]) {
    if (!(key in extraEnv)) delete env[key];
  }
  // Same launch as Playwright's webServer: `config.webServer.command` through a shell, detached so the
  // server leads its own process group.
  const command = (config.webServer as { command: string }).command;
  const child = spawn(command, { cwd: repoRoot, env, shell: true, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) =>
    child.once("close", (code, signal) => resolveClose({ code, signal })),
  );
  return { child, closed, stderr: () => stderr };
}

async function waitForHealth(port: number, child: ChildProcess, stderr: () => string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`browser server exited early: ${stderr()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`browser server did not become healthy: ${stderr()}`);
}

function newBase() {
  const base = mkdtempSync(join(tmpdir(), "sonder-bs-cleanup-"));
  bases.push(base);
  return base;
}

test("Playwright stops the browser server with a signal it can handle", () => {
  const webServer = config.webServer as { gracefulShutdown?: { signal: string; timeout: number } };
  assert.equal(webServer.gracefulShutdown?.signal, "SIGTERM");
  assert.ok((webServer.gracefulShutdown?.timeout ?? 0) > 0, "a zero timeout waits forever on a hung server");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`the browser server removes its temp directory on ${signal} to its process group`, { timeout: 60_000 }, async () => {
    const base = newBase();
    const port = await freePort();
    const server = startServer(base, port);
    try {
      await waitForHealth(port, server.child, server.stderr);
      const running = serverDirs(base);
      assert.equal(running.length, 1, "the server made one temp directory");
      const marker = join(base, running[0], ".sonder-pid");
      assert.match(readFileSync(marker, "utf8"), /^\d+\n$/, "the server names its PID for clean-temp.sh");
      // Like Playwright, wait for the launched shell to close: its stdio closes only once the server has
      // exited, after its handler ran.
      process.kill(-server.child.pid!, signal);
      await server.closed;
      assert.deepEqual(serverDirs(base), [], "the temp directory is gone after the server stops");
    } finally {
      try {
        process.kill(-server.child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

test("SONDER_KEEP_BROWSER_TEMP=1 keeps the directory for debugging", { timeout: 60_000 }, async () => {
  const base = newBase();
  const port = await freePort();
  const server = startServer(base, port, { SONDER_KEEP_BROWSER_TEMP: "1" });
  try {
    await waitForHealth(port, server.child, server.stderr);
    process.kill(-server.child.pid!, "SIGTERM");
    await server.closed;
    const kept = serverDirs(base);
    assert.equal(kept.length, 1, "the directory is kept");
    assert.ok(existsSync(join(base, kept[0], "db")), "with the database in it");
    assert.ok(!existsSync(join(base, kept[0], ".sonder-pid")), "but no stale PID marker");
    assert.match(server.stderr(), /kept .*SONDER_KEEP_BROWSER_TEMP=1/);
  } finally {
    try {
      process.kill(-server.child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("a server that cannot start still removes its temp directory", { timeout: 60_000 }, async () => {
  const base = newBase();
  const blocker = net.createServer();
  await new Promise<void>((resolveListen) => blocker.listen(0, "127.0.0.1", () => resolveListen()));
  const { port } = blocker.address() as net.AddressInfo;
  try {
    const server = startServer(base, port);
    const { code } = await server.closed;
    assert.notEqual(code, 0, "listening on a used port fails");
    assert.deepEqual(serverDirs(base), [], "the exit path removes the directory too");
  } finally {
    await new Promise((resolveClose) => blocker.close(resolveClose));
  }
});

test("an adopted wrapper directory is left for the wrapper, without the server's marker", { timeout: 60_000 }, async () => {
  const base = newBase();
  const owned = mkdtempSync(join(base, "sonder-browser-"));
  const port = await freePort();
  const server = startServer(base, port, { SONDER_BROWSER_TEMP: owned });
  try {
    await waitForHealth(port, server.child, server.stderr);
    assert.deepEqual(serverDirs(base), [owned.slice(base.length + 1)], "the server adopted the wrapper's directory");
    assert.ok(existsSync(join(owned, ".sonder-pid")));
    process.kill(-server.child.pid!, "SIGTERM");
    await server.closed;
    assert.ok(existsSync(owned), "scripts/test-browser.mjs removes the directory it owns");
    assert.ok(!existsSync(join(owned, ".sonder-pid")));
  } finally {
    try {
      process.kill(-server.child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }
});
