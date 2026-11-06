import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consensusCellCount } from "../server/ebook-set-aligner.ts";
import { executeConsensusWorker, runConsensusBuild, ConsensusSupersededError } from "../server/ebook-set-consensus-runner.ts";

const sentences = (n: number) => Array.from({length: n}, (_, i) => ({text: `sentence ${i}`, norm: `sentence ${i}`, paragraphId: `${i}`, section: 0}));

test("cell estimate matches visited bands including unequal lists", () => {
  for (let n = 1; n < 300; n += 13) for (let m = 1; m < 300; m += 17) {
    const band = Math.min(m, Math.max(Math.abs(n - m), 64, Math.min(1500, Math.ceil(Math.max(n, m) * .03))));
    let cells = 0;
    for (let i = 0; i <= n; i++) cells += Math.max(0, Math.min(m, i + band) - Math.max(0, i - band) + 1);
    assert.equal(consensusCellCount(n, m), cells, `${n},${m}`);
  }
});

test("worker failures and deadlines release the thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sonder-consensus-worker-"));
  try {
    const fail = join(dir, "fail.cjs"), hang = join(dir, "hang.cjs");
    writeFileSync(fail, 'throw new Error("fixture failure")');
    writeFileSync(hang, 'setInterval(() => {}, 1000)');
    for (const [path, timeout, pattern] of [[fail, 5000, /fixture failure/], [hang, 50, /timed out/]] as const) {
      const worker = new Worker(path);
      await assert.rejects(executeConsensusWorker([], { createWorker: () => worker, timeoutMs: timeout }), pattern);
      assert.equal(worker.threadId, -1);
    }
    assert.deepEqual(await runConsensusBuild("after-failure", [[...sentences(1)]]), [{text: "sentence 0", norm: "sentence 0", memberParagraphIds: ["0"]}]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("one worker runs while newer pending work replaces older pending work", async () => {
  const list = sentences(12000);
  const active = runConsensusBuild("active", [list, list]);
  const old = runConsensusBuild("queued", [[...sentences(1)]]);
  const rejected = assert.rejects(old, ConsensusSupersededError);
  const latest = runConsensusBuild("queued", [[...sentences(2)]]);
  await rejected;
  assert.equal((await active).length, list.length);
  assert.equal((await latest).length, 2);
});

test("over-budget input fails before a worker starts", async () => {
  const huge = Array(210000).fill({text: "a", norm: "a", paragraphId: "a", section: 0});
  await assert.rejects(runConsensusBuild("budget", [huge, huge]), /too long/);
});
