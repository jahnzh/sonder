import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Importing the app opens its database, so never use the image's DATA_DIR.
const dataDir = mkdtempSync(join(tmpdir(), "sonder-image-smoke-"));
process.env.DATA_DIR = dataDir;
const serverModule = (name) => pathToFileURL(resolve("server", name)).href;
const execFileAsync = promisify(execFile);

function isOnPath(command) {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => {
    const path = join(dir, command);
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

async function checkAlignmentPool() {
  const { ctcHealthProblem, defaultPoolHosts } = await import(serverModule("alignment-pool.ts"));
  // Every configured pool host (ALIGNMENT_POOL_HOSTS, or the default WSL and lisa).
  const hosts = defaultPoolHosts();
  const names = hosts.map((host) => `${host.id} (${host.sshTarget})`).join(", ");
  for (const command of ["ssh", "scp"]) {
    if (!isOnPath(command)) {
      throw new Error(`alignment pool hosts ${names}: ${command} is missing or not executable on PATH`);
    }
  }
  // A host that cannot be reached (no answer, a dropped connection, ssh failing) is a warning while another host
  // passes both checks: the pool dispatches to the hosts that answer. A host that answers wrongly (HTTP error, not
  // JSON, another engine or device) is a misconfiguration and fails the deploy.
  const unreachable = [];
  let reachable = 0;
  for (const host of hosts) {
    const name = `${host.id} (${host.sshTarget})`;
    const healthUrl = `${host.workerUrl.replace(/\/$/, "")}/health`;
    let response;
    try {
      response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      unreachable.push(`alignment pool host ${name}: health check ${healthUrl} failed: ${error.message}`);
      continue;
    }
    try {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("the answer is not JSON");
      }
      // The server's own dispatch rule: ready, the pinned CTC engine with its model, this host's configured device.
      const problem = ctcHealthProblem(host, body);
      if (problem) throw new Error(problem);
    } catch (error) {
      throw new Error(`alignment pool host ${name}: health check ${healthUrl} failed: ${error.message}`);
    }
    try {
      await execFileAsync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.sshTarget, "true"], { timeout: 7000 });
    } catch (error) {
      unreachable.push(`alignment pool host ${name}: ssh true failed: ${error.message}`);
      continue;
    }
    reachable += 1;
  }
  if (reachable === 0) throw new Error(unreachable.join("\n") || `alignment pool hosts ${names}: none configured`);
  for (const line of unreachable) console.warn(`warning: ${line} (another pool host answers)`);
  console.log("image smoke passed: alignment pool health and SSH");
}

// Prepared text is made on a thread of its own (#827), started from a TypeScript file: this is the one place that
// shows the built image can start it (the file is there, the loader reaches it, the temp folder can be written).
async function checkPreparingThread() {
  const { prepareOffThread } = await import(serverModule("prepared-text-cache.ts"));
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>');
  zip.file("content.opf", '<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>');
  zip.file("a.xhtml", "<html><body><p>Hello world.</p></body></html>");
  const source = join(dataDir, "smoke.epub");
  writeFileSync(source, await zip.generateAsync({ type: "nodebuffer" }));
  const bytes = await prepareOffThread(
    { source, temp: join(dataDir, "smoke-prepared"), base: "/api/reader/smoke/prepared/0000000000000000", key: "0000000000000000", book: { id: "smoke", fingerprint: "", language: "en" } },
    [{ index: 0, href: "a.xhtml", title: "", paragraphs: [{ id: "0:0", text: "Hello world.", blockIndex: 0, start: 0, end: 12 }] }],
  );
  assert.ok(bytes > 0, "the preparing thread wrote nothing");
  console.log("image smoke passed: prepared text is made on its own thread");
}

try {
  const { createApp } = await import(serverModule("app.ts"));
  assert.equal(typeof createApp, "function");
  const { runConsensusBuild } = await import(serverModule("ebook-set-consensus-runner.ts"));
  const sentence = { text: "Hello world.", norm: "hello world", paragraphId: "p1", section: 0 };
  const rows = await runConsensusBuild("image-smoke", [[sentence], [sentence]]);
  assert.deepEqual(rows, [{ text: "Hello world.", norm: "hello world", memberParagraphIds: ["p1", "p1"] }]);
  console.log("image smoke passed: server imports and consensus worker");
  await checkPreparingThread();
  if (process.env.ALIGNMENT_POOL_ENABLED === "1") await checkAlignmentPool();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
