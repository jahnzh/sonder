import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
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

const CTC_HOST_IDS = new Set(["wsl", "lisa"]);

async function checkAlignmentPool() {
  const { ctcHealthProblem, defaultPoolHosts } = await import(serverModule("alignment-pool.ts"));
  const hosts = defaultPoolHosts().filter((host) => CTC_HOST_IDS.has(host.id));
  const names = hosts.map((host) => `${host.id} (${host.sshTarget})`).join(", ");
  for (const command of ["ssh", "scp"]) {
    if (!isOnPath(command)) {
      throw new Error(`alignment pool hosts ${names}: ${command} is missing or not executable on PATH`);
    }
  }
  for (const host of hosts) {
    const name = `${host.id} (${host.sshTarget})`;
    const healthUrl = `${host.workerUrl.replace(/\/$/, "")}/health`;
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("the answer is not JSON");
      }
      // The server's own dispatch rule: ready, the pinned CTC engine with its model, this host's device.
      const problem = ctcHealthProblem(host, body);
      if (problem) throw new Error(problem);
    } catch (error) {
      throw new Error(`alignment pool host ${name}: health check ${healthUrl} failed: ${error.message}`);
    }
    try {
      await execFileAsync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host.sshTarget, "true"], { timeout: 7000 });
    } catch (error) {
      throw new Error(`alignment pool host ${name}: ssh true failed: ${error.message}`);
    }
  }
  console.log("image smoke passed: alignment pool health and SSH");
}

try {
  const { createApp } = await import(serverModule("app.ts"));
  assert.equal(typeof createApp, "function");
  const { runConsensusBuild } = await import(serverModule("ebook-set-consensus-runner.ts"));
  const sentence = { text: "Hello world.", norm: "hello world", paragraphId: "p1", section: 0 };
  const rows = await runConsensusBuild("image-smoke", [[sentence], [sentence]]);
  assert.deepEqual(rows, [{ text: "Hello world.", norm: "hello world", memberParagraphIds: ["p1", "p1"] }]);
  console.log("image smoke passed: server imports and consensus worker");
  if (process.env.ALIGNMENT_POOL_ENABLED === "1") await checkAlignmentPool();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
