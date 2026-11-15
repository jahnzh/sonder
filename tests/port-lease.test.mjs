// The port-lease folder (<tmp>/sonder-port-leases) must exist whenever a lease is being acquired (test
// leftovers, item 3). A check failed in setup with ENOENT because releasing a lease removed the folder
// once it was empty, and the acquirer that had created it at the start of its scan then wrote into a
// folder that was gone. Each test points TMPDIR at its own temp base, so no host-wide folder is touched.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { acquirePortLease, releasePortLease } from "../scripts/check-local-support.mjs";

const bases = [];
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true });
});

async function withTempBase(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-port-lease-"));
  bases.push(base);
  const previousTmp = process.env.TMPDIR;
  const previousPort = process.env.CHECK_LOCAL_PORT;
  process.env.TMPDIR = base;
  delete process.env.CHECK_LOCAL_PORT;
  try {
    assert.equal(os.tmpdir(), base, "os.tmpdir() follows TMPDIR");
    await run(path.join(base, "sonder-port-leases"));
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    if (previousPort === undefined) delete process.env.CHECK_LOCAL_PORT;
    else process.env.CHECK_LOCAL_PORT = previousPort;
  }
}

function listen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test("acquiring a lease creates a missing lease folder", async () => {
  await withTempBase(async (leaseDir) => {
    assert.equal(fs.existsSync(leaseDir), false);
    const lease = await acquirePortLease();
    try {
      assert.ok(fs.existsSync(lease.lockPath), "the lock file is in the new folder");
      assert.equal(path.dirname(lease.lockPath), leaseDir);
    } finally {
      releasePortLease(lease);
    }
  });
});

test("the scan survives a busy first port whose released lease emptied the folder", async () => {
  await withTempBase(async (leaseDir) => {
    // Pin the scan start, then make that first candidate busy: its lease is taken and released again
    // before the scan moves on, which left the folder empty and removed it mid-scan.
    const random = Math.random;
    Math.random = () => 0;
    const blocker = await listen(14100);
    try {
      const lease = await acquirePortLease();
      try {
        assert.notEqual(lease.port, 14100, "the busy port is skipped");
        assert.ok(fs.existsSync(lease.lockPath));
        assert.ok(fs.existsSync(leaseDir));
      } finally {
        releasePortLease(lease);
      }
    } finally {
      Math.random = random;
      if (blocker) await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

test("releasing one lease never removes the folder while another lease is held", async () => {
  await withTempBase(async (leaseDir) => {
    const held = await acquirePortLease();
    try {
      const other = await acquirePortLease();
      releasePortLease(other);
      assert.ok(fs.existsSync(leaseDir), "the folder stays while a lease is held");
      assert.ok(fs.existsSync(held.lockPath), "and so does the held lock");
    } finally {
      releasePortLease(held);
    }
    // The last release tidies the empty folder, so a fresh TMPDIR is left as it was.
    assert.equal(fs.existsSync(leaseDir), false);
    const again = await acquirePortLease();
    releasePortLease(again);
  });
});
