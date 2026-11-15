// An invalid ALIGNMENT_POOL_HOSTS stops the server at startup (ADR 0013): it never starts a pool without hosts.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const temp = mkdtempSync(join(tmpdir(), "sonder-pool-startup-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "admin-password";
delete process.env.TRANSMISSION_RPC_URL;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;
const { createApp } = await import("../server/app.ts");
const { getAlignmentPoolCoordinator, resetAlignmentPoolCoordinator } = await import("../server/alignment-pool.ts");
after(() => {
  delete process.env.ALIGNMENT_POOL_HOSTS;
  rmSync(temp, { recursive: true, force: true });
});

const host = (id: string) => ({ id, sshTarget: id, workerUrl: `http://${id}:3012`, device: "cpu", precision: "float32" });

test("the server does not start on an invalid ALIGNMENT_POOL_HOSTS, and says which setting and why", async () => {
  const { sshTarget: _sshTarget, ...withoutSsh } = host("a");
  const cases: [string, RegExp][] = [
    ["[{", /ALIGNMENT_POOL_HOSTS is not JSON/],
    ["[]", /ALIGNMENT_POOL_HOSTS must be a non-empty JSON array/],
    [JSON.stringify([withoutSsh]), /ALIGNMENT_POOL_HOSTS\[0\]\.sshTarget must be a non-empty string/],
    [JSON.stringify([host("a"), host("a")]), /ALIGNMENT_POOL_HOSTS: host ids must be unique/],
  ];
  for (const [raw, reason] of cases) {
    process.env.ALIGNMENT_POOL_HOSTS = raw;
    resetAlignmentPoolCoordinator();
    await assert.rejects(createApp(), reason, raw);
  }
});

test("the server starts with the default hosts when ALIGNMENT_POOL_HOSTS is empty", async () => {
  process.env.ALIGNMENT_POOL_HOSTS = "";
  resetAlignmentPoolCoordinator();
  const app = await createApp();
  try {
    assert.deepEqual(getAlignmentPoolCoordinator().listHosts().map((entry) => entry.id), ["wsl", "lisa"]);
  } finally {
    await app.close();
  }
});
