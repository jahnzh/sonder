// Optional scale probe: node scripts/probe-consensus.ts 20000 (or 50000).
import assert from "node:assert/strict";
import { consensusCellCount } from "../server/ebook-set-aligner.ts";
import { runConsensusBuild } from "../server/ebook-set-consensus-runner.ts";
const n = Number(process.argv[2]);
if (![20000, 50000].includes(n)) throw new Error("Choose 20000 or 50000 sentences.");
const list = Array.from({length: n}, (_, i) => ({text: `Sentence ${i}.`, norm: `Sentence ${i}.`, paragraphId: `${i}`, section: 0}));
const started = performance.now();
const rows = await runConsensusBuild("probe", [list, list]);
assert.equal(rows.length, n);
for (let i = 0; i < n; i++) assert.deepEqual(rows[i], {text: list[i].text, norm: list[i].norm, memberParagraphIds: [`${i}`, `${i}`]});
const band = Math.min(1500, Math.ceil(n * .03));
const cells = consensusCellCount(n, n);
console.log(JSON.stringify({n, elapsedMs: performance.now() - started, peakRssMiB: process.resourceUsage().maxRSS / 1024, cells, bufferBytes: cells + (n + 2) * 8 + (2 * band + 1) * 16}));
