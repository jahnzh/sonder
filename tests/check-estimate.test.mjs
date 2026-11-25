// scripts/check-estimate.mjs: how long a check will take on a host, from the table of times (the bar's figures).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_BAR_SECONDS, barSeconds, compareWithReport, estimateLines, estimateOnHost } from "../scripts/check-estimate.mjs";

const lisa = { fixedSeconds: 308, speed: 1, shards: 6, startSeconds: 80 };
const wsl = { fixedSeconds: 85, speed: 0.46, shards: 5, startSeconds: 60 };
const suite = Array.from({ length: 12 }, (_item, index) => ({ file: `tests/e2e/s${String(index).padStart(2, "0")}.spec.ts`, seconds: 600 }));

test("an ordinary check: the fixed stages and the browser stage's longest shard", () => {
  // Twelve files of 600 s: two a shard on lisa's six, and 3, 3, 2, 2, 2 on WSL's five.
  assert.deepEqual(estimateOnHost({ suite, changed: [], scope: "full" }, lisa), { seconds: 308 + 1200 + 80, fixed: 308, browser: 1280, repeat: 0 });
  assert.deepEqual(estimateOnHost({ suite, changed: [], scope: "full" }, wsl), { seconds: 85 + 828 + 60, fixed: 85, browser: 888, repeat: 0 });
  assert.equal(estimateOnHost({ suite, changed: [], scope: "skip" }, lisa).seconds, 308, "no browser stage");
  assert.equal(estimateOnHost({ suite, changed: [], scope: "chromium" }, lisa).browser, 480 + 80, "chromium alone is two fifths");
});

test("changed specs add the repeat stage: two passes, the longest part, only the projects a spec is repeated in", () => {
  const changed = (share) => suite.slice(0, 6).map((entry) => ({ ...entry, share }));
  // Six changed specs in six parts on lisa: one each, 600 s twice.
  assert.equal(estimateOnHost({ suite, changed: changed(1), scope: "full" }, lisa).repeat, 0, "not repeated unless asked (#904)");
  assert.equal(estimateOnHost({ suite, changed: changed(1), scope: "full", repeatChanged: true }, lisa).repeat, 1200 + 40);
  // In five parts on WSL the longest has two.
  assert.equal(estimateOnHost({ suite, changed: changed(1), scope: "full", repeatChanged: true }, wsl).repeat, Math.round(2400 * 0.46 + 30));
  // A spec that only gained one of three projects costs a third.
  assert.equal(estimateOnHost({ suite, changed: changed(1 / 3), scope: "full", repeatChanged: true }, lisa).repeat, 400 + 40);
  // One heavy file bounds its part however many parts there are.
  assert.equal(estimateOnHost({ suite, changed: [{ file: suite[0].file, seconds: 600, share: 1 }], scope: "full", repeatChanged: true }, lisa).repeat, 1240);
});

test("the lines name each host's figures, the hosts that fit the bar and those over it", () => {
  const config = { dispatch: { barSeconds: 1800 }, lisa: { estimate: lisa }, wsl: { estimate: wsl }, deck: {} };
  const commit = { suite, changed: suite.slice(0, 6).map((entry) => ({ ...entry, share: 1 })), scope: "full", repeatChanged: true };
  const result = estimateLines(commit, ["wsl", "lisa", "deck"], config, {});
  assert.deepEqual(result.lines, [
    "estimate wsl 35.1min fixed=85s browser=888s repeat=1134s changed_specs=6",
    "estimate lisa 47.1min fixed=308s browser=1280s repeat=1240s changed_specs=6",
    "estimate deck none: no estimate entry for this host",
    "bar 30.0min fits=deck judged=none over=wsl,lisa",
  ]);
  assert.deepEqual([result.fits, result.judged, result.over], [["deck"], [], ["wsl", "lisa"]]);
  const ordinary = estimateLines({ suite, changed: [], scope: "full" }, ["wsl", "lisa"], config, {});
  assert.equal(ordinary.lines.at(-1), "bar 30.0min fits=wsl,lisa judged=wsl,lisa over=none");
  // An estimate that cannot be made judges no host.
  const none = estimateLines({ error: "the commit has no table of times (tests/e2e/spec-seconds.json)" }, ["wsl", "lisa"], config, {});
  assert.deepEqual([none.lines, none.fits, none.over], [["estimate none: the commit has no table of times (tests/e2e/spec-seconds.json); no host is judged"], ["wsl", "lisa"], []]);
});

test("the bar is 30 minutes, a named setting of the hosts file, and SONDER_CI_BAR_SECONDS for one run", () => {
  assert.equal(DEFAULT_BAR_SECONDS, 1800);
  assert.equal(barSeconds({}, {}), 1800);
  assert.equal(barSeconds({ dispatch: { barSeconds: 2400 } }, {}), 2400);
  assert.equal(barSeconds({ dispatch: { barSeconds: 2400 } }, { SONDER_CI_BAR_SECONDS: "900" }), 900);
  for (const bad of ["", "0", "-5", "soon"]) assert.equal(barSeconds({ dispatch: { barSeconds: 2400 } }, { SONDER_CI_BAR_SECONDS: bad }), 2400, bad);
  const tracked = JSON.parse(fs.readFileSync(new URL("../scripts/ci-hosts.json", import.meta.url), "utf8"));
  assert.equal(tracked.dispatch.barSeconds, 1800, "the tracked bar");
  for (const id of ["wsl", "lisa"]) assert.ok(tracked[id].estimate.fixedSeconds > 0 && tracked[id].estimate.shards > 0, `${id} has figures`);
});

test("a finished check says which stage was more than a tenth off its estimate, and what to refresh", () => {
  const config = { lisa: { estimate: lisa }, wsl: { estimate: wsl }, deck: {} };
  const commit = { suite, changed: [], scope: "full" };
  const report = (browserSeconds, unitSeconds = 245, result = "passed") => ({
    result, sha: "70c08ca5d6befd9797817cf3da38a0757fa45a23",
    stages: [{ name: "install", status: "passed", durationMs: 10_000 }, { name: "build", status: "passed", durationMs: 53_000 }, { name: "unit", status: "passed", durationMs: unitSeconds * 1000 }, { name: "browser", status: "passed", durationMs: browserSeconds * 1000 }],
  });
  // lisa's estimate here: fixed 308, browser 1,280.
  assert.deepEqual(compareWithReport(commit, "lisa", config, report(1300)), [], "within a tenth: nothing");
  const [late] = compareWithReport(commit, "lisa", config, report(1603), "artifacts/ci/70c0/run");
  assert.match(late, /^estimate off on lisa: the browser stage estimated 1280 s, took 1603 s \(\+25 %\)\. Refresh the table of times from this check: node scripts\/spec-seconds\.mjs artifacts\/ci\/70c0\/run\/playwright-results\.json "lisa, 70c08ca, \d{4}-\d\d-\d\d"$/);
  assert.match(compareWithReport(commit, "lisa", config, report(1000))[0], /took 1000 s \(-22 %\)/, "too high an estimate is said too");
  // On a host whose seconds are not the table's, the figure to set is its speed.
  assert.match(compareWithReport(commit, "wsl", config, report(1200, 22))[0], /^estimate off on wsl: the browser stage estimated 888 s, took 1200 s \(\+35 %\)\. Set estimate\.speed for wsl in scripts\/ci-hosts\.json \(it is 0\.46\)/);
  assert.match(compareWithReport(commit, "lisa", config, report(1300, 420))[0], /^estimate off on lisa: the fixed stages \(install, build, unit\) estimated 308 s, took 483 s \(\+57 %\)\. Set estimate\.fixedSeconds for lisa/);
  // No measurement: a check that failed, a host without figures, no report.
  assert.deepEqual(compareWithReport(commit, "lisa", config, report(400, 245, "failed")), []);
  assert.deepEqual(compareWithReport(commit, "lisa", config, report(1603, 245, "passed_with_flaky")).length, 1);
  assert.deepEqual(compareWithReport(commit, "deck", config, report(1603)), []);
  assert.deepEqual(compareWithReport(commit, "lisa", config, null), []);
});
