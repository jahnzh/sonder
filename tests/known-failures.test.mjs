import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadKnownFailures,
  classifyBrowserRun,
  evaluateBrowserRun,
  validateKnownFailures,
  collectPlaywrightTests,
  slowestPlaywrightTests,
  planReruns,
  rerunPlaywrightArgs,
  applyReruns,
  browserSummaryLines,
  DEFAULT_MAX_RERUNS,
} from "../scripts/known-failures.mjs";
import { playwrightReport, knownFailuresDocument } from "./playwright-report-fixture.mjs";

const SPEC = "tests/e2e/device-reset.spec.ts";
const LAYOUT = "tests/e2e/now-playing-layout.spec.ts";
const SEEK = "tests/e2e/playback-workflow.spec.ts";

/** Every triple here must stay in tests/known-failures.wsl-host.json; the file may add more. */
const WSL_HOST_REQUIRED_ENTRIES = [
    {project: "chromium", file: "tests/e2e/playback-workflow.spec.ts", title: "touch seeking › releasing a fine-seek gesture keeps the exact previewed destination"},
];

const knownFailureKey = ({project, file, title}) => `${project}\0${file}\0${title}`;

const entries = validateKnownFailures(knownFailuresDocument([
    {project: "webkit", file: SPEC, title: "reset refreshes the app shell"},
    {project: "webkit", file: LAYOUT, title: "reader-first at 360px"},
    {project: "chromium", file: SEEK, title: ["touch seeking", "fine-seek keeps destination"], kind: "intermittent"},
].map((e) => ({...e, title: Array.isArray(e.title) ? e.title.join(" › ") : e.title})))).entries;

const t = (project, file, title, status) => ({project, file, title, status});

test("classification: every failure is listed -> passed_with_known_failures", () => {
    const report = playwrightReport([
        t("webkit", SPEC, "reset refreshes the app shell", "unexpected"),
        t("webkit", LAYOUT, "reader-first at 360px", "unexpected"),
        t("chromium", SEEK, ["touch seeking", "fine-seek keeps destination"], "unexpected"),
        t("chromium", SPEC, "reset refreshes the app shell", "expected"),
    ]);
    const outcome = classifyBrowserRun({entries, report, stageExitCode: 1});
    assert.equal(outcome.result, "passed_with_known_failures");
    assert.equal(outcome.knownFailures.length, 3);
    assert.deepEqual(outcome.newFailures, []);
    assert.deepEqual(outcome.knownFailures.map((f) => f.kind), ["environment", "environment", "intermittent"]);
    assert.equal(outcome.knownFailures[0].message, "Error: expected 1", "message is the first line without ANSI codes");
    assert.match(outcome.summary, /^passed_with_known_failures: 3 known failures \(2 environment, 1 intermittent\), 0 new/);
});

test("classification: one unlisted failure among known ones -> failed", () => {
    const report = playwrightReport([
        t("webkit", SPEC, "reset refreshes the app shell", "unexpected"),
        t("chromium", SPEC, "reset leaves the offline shell intact", "unexpected"),
    ]);
    const outcome = classifyBrowserRun({entries, report, stageExitCode: 1});
    assert.equal(outcome.result, "failed");
    assert.equal(outcome.knownFailures.length, 1);
    assert.deepEqual(outcome.newFailures.map((f) => [f.project, f.file, f.title]),
        [["chromium", SPEC, "reset leaves the offline shell intact"]]);
});

test("classification: a listed test failing in another project, file or title is new", () => {
    for (const failure of [
        t("chromium", SPEC, "reset refreshes the app shell", "unexpected"),
        t("webkit", LAYOUT, "reset refreshes the app shell", "unexpected"),
        t("webkit", SPEC, "reset refreshes the app shell twice", "unexpected"),
    ]) {
        const outcome = classifyBrowserRun({entries, report: playwrightReport([failure]), stageExitCode: 1});
        assert.equal(outcome.result, "failed", JSON.stringify(failure));
        assert.equal(outcome.newFailures.length, 1);
    }
});

test("classification: nothing failing -> passed, and listed entries not seen are reported as not run", () => {
    const report = playwrightReport([t("chromium", SPEC, "reset refreshes the app shell", "expected")]);
    const outcome = classifyBrowserRun({entries, report, stageExitCode: 0});
    assert.equal(outcome.result, "passed");
    assert.deepEqual(outcome.knownFailures, []);
    assert.deepEqual(outcome.newFailures, []);
    assert.deepEqual(outcome.listedPassed, []);
    assert.equal(outcome.listedNotRun.length, 3, "none of the three listed (project, file, title) triples ran");
});

test("classification: a listed test that passed is reported so the list can shrink", () => {
    const report = playwrightReport([
        t("webkit", SPEC, "reset refreshes the app shell", "expected"),
        t("webkit", LAYOUT, "reader-first at 360px", "unexpected"),
    ]);
    const outcome = classifyBrowserRun({entries, report, stageExitCode: 1});
    assert.equal(outcome.result, "passed_with_known_failures");
    assert.deepEqual(outcome.listedPassed.map((e) => [e.project, e.file, e.title, e.outcome]),
        [["webkit", SPEC, "reset refreshes the app shell", "passed"]]);
    assert.match(outcome.summary, /1 listed test passed/);
});

test("classification: failure titles include describe blocks, matching the list reporter", () => {
    const report = playwrightReport([t("chromium", SEEK, ["touch seeking", "fine-seek keeps destination"], "unexpected")]);
    const outcome = classifyBrowserRun({entries, report, stageExitCode: 1});
    assert.equal(outcome.result, "passed_with_known_failures");
    assert.equal(outcome.knownFailures[0].title, "touch seeking › fine-seek keeps destination");
});

test("classification: a non-zero stage never passes on a report that cannot account for it", () => {
    const failing = [t("webkit", SPEC, "reset refreshes the app shell", "unexpected")];
    const cases = {
        "missing report": {report: null, reportError: "Playwright JSON report was not written"},
        "not a Playwright report": {report: {hello: "world"}},
        "run-level error": {report: playwrightReport(failing, {errors: [{message: "Error: webServer exited"}]})},
        "no failing test in report": {report: playwrightReport([t("webkit", SPEC, "reset refreshes the app shell", "expected")])},
        "counts disagree with tests": {report: playwrightReport(failing, {stats: {expected: 0, skipped: 0, unexpected: 2, flaky: 0}})},
    };
    for (const [name, input] of Object.entries(cases)) {
        const outcome = classifyBrowserRun({entries, stageExitCode: 1, ...input});
        assert.equal(outcome.result, "failed", name);
        assert.ok(outcome.error, name);
    }
});

test("classification: an unreadable report does not fail a stage that exited 0", () => {
    const outcome = classifyBrowserRun({entries, report: null, reportError: "Playwright JSON report was not written", stageExitCode: 0});
    assert.equal(outcome.result, "passed");
    assert.match(outcome.error, /not written/);
});

test("evaluateBrowserRun reads the report from disk and treats a missing or corrupt file as unusable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "known-failures-eval-"));
    try {
        const reportPath = path.join(dir, "playwright-results.json");
        assert.equal(evaluateBrowserRun({entries, reportPath, stageExitCode: 1}).result, "failed");
        fs.writeFileSync(reportPath, "{not json");
        assert.equal(evaluateBrowserRun({entries, reportPath, stageExitCode: 1}).result, "failed");
        fs.writeFileSync(reportPath, JSON.stringify(playwrightReport([t("webkit", SPEC, "reset refreshes the app shell", "unexpected")])));
        assert.equal(evaluateBrowserRun({entries, reportPath, stageExitCode: 1}).result, "passed_with_known_failures");
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test("malformed known-failures files are rejected with a reason", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "known-failures-file-"));
    const write = (name, content) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
        return file;
    };
    const good = {project: "webkit", file: SPEC, title: "x", kind: "environment", reason: "why", issue: 37};
    try {
        const cases = [
            ["not JSON", write("a.json", "{nope"), /not valid JSON/],
            ["missing file", path.join(dir, "absent.json"), /cannot read/],
            ["array root", write("b.json", []), /JSON object/],
            ["wrong version", write("c.json", {version: 2, entries: []}), /unsupported version/],
            ["entries not an array", write("d.json", {version: 1, entries: {}}), /"entries" must be an array/],
            ["unknown kind", write("e.json", {version: 1, entries: [{...good, kind: "flaky"}]}), /kind must be one of/],
            ["empty title", write("f.json", {version: 1, entries: [{...good, title: " "}]}), /title must be a non-empty string/],
            ["no reason", write("g.json", {version: 1, entries: [{...good, reason: undefined}]}), /reason must be a non-empty string/],
            ["bad issue", write("h.json", {version: 1, entries: [{...good, issue: "37"}]}), /issue must be a positive integer/],
            ["duplicate entry", write("i.json", {version: 1, entries: [good, good]}), /duplicates/],
        ];
        for (const [name, file, pattern] of cases) {
            const loaded = loadKnownFailures(file);
            assert.equal(loaded.ok, false, name);
            assert.match(loaded.error, pattern, name);
        }
        assert.equal(loadKnownFailures(write("ok.json", {version: 1, entries: [good]})).ok, true);
        assert.equal(loadKnownFailures(write("empty.json", {version: 1, entries: []})).ok, true);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test("the committed WSL host list is valid and does not mask reader regressions", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const loaded = loadKnownFailures(path.join(root, "tests", "known-failures.wsl-host.json"));
    assert.equal(loaded.ok, true, loaded.error);
    const committedKeys = new Set(loaded.entries.map(knownFailureKey));
    for (const required of WSL_HOST_REQUIRED_ENTRIES) {
        assert.ok(
            committedKeys.has(knownFailureKey(required)),
            `known-failures.wsl-host.json is missing ${required.project} ${required.file}: ${required.title}`,
        );
    }
    // An intermittent failure is rerun alone and reported as flaky (#792); listing it would only hide a test
    // that fails twice. The list keeps the failures that fail on the host every time.
    assert.deepEqual(loaded.entries.filter((e) => e.kind === "intermittent").map((e) => e.title), [],
        "intermittent failures belong to the rerun, not the WSL host list");
    for (const project of ["chromium", "firefox"]) {
        const gesture = t(project, "tests/e2e/reader-frame.spec.ts", "taps, page turns and long-press on the book page reach the reader", "unexpected");
        const outcome = classifyBrowserRun({entries: loaded.entries, report: playwrightReport([gesture]), stageExitCode: 1});
        assert.equal(outcome.result, "failed", `${project} reader gesture regression must fail the check`);
        assert.equal(outcome.newFailures.length, 1);
    }
    const layout = t("webkit", LAYOUT, "#122 reader Back to narration layout › firefox/webkit smoke: transport centred and ordered at 390px and 1280px", "unexpected");
    const outcome = classifyBrowserRun({entries: loaded.entries, report: playwrightReport([layout]), stageExitCode: 1});
    assert.equal(outcome.result, "failed", "WebKit Back to narration regression must fail the check");
    assert.equal(outcome.newFailures.length, 1);
    for (const entry of loaded.entries) {
        const source = fs.readFileSync(path.join(root, entry.file), "utf8");
        const leaf = entry.title.split(" › ").pop().replace(/\d+px$/, "");
        // A title built from a template (`following narration on ${label} ...`) is in the source with its placeholder.
        const templated = source.split("\n").some((line) => {
            const match = /test\(`([^`]*\$\{[^`]*)`/.exec(line);
            if (!match) return false;
            const pattern = match[1].split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+");
            return new RegExp(`^${pattern}$`).test(leaf);
        });
        assert.ok(source.includes(leaf) || templated, `${entry.file} should contain "${leaf}"`);
    }
});

test("an interrupted test is never a known failure, even when it is listed", () => {
    const report = playwrightReport([
        t("webkit", SPEC, "reset refreshes the app shell", "interrupted"),
        t("webkit", LAYOUT, "reader-first at 360px", "unexpected"),
    ]);
    const outcome = classifyBrowserRun({entries, report, stageExitCode: 1});
    assert.equal(outcome.result, "failed");
    assert.match(outcome.error, /1 test\(s\) were interrupted/);
    assert.equal(outcome.newFailures.length, 1);
    assert.equal(outcome.newFailures[0].title, "reset refreshes the app shell");
    assert.equal(outcome.knownFailures.length, 1);
});

test("a browser stage stopped by a signal fails even when every listed failure is known", () => {
    const report = playwrightReport([
        t("webkit", SPEC, "reset refreshes the app shell", "unexpected"),
        t("webkit", LAYOUT, "reader-first at 360px", "unexpected"),
    ]);
    const outcome = classifyBrowserRun({entries, report, stageExitCode: null, stageSignal: "SIGTERM"});
    assert.equal(outcome.result, "failed");
    assert.equal(outcome.error, "browser stage was stopped by SIGTERM");
    assert.match(outcome.summary, /stopped by SIGTERM/);
});

test("a signal also fails a run whose report is missing", () => {
    const outcome = classifyBrowserRun({entries, report: null, reportError: "no report", stageExitCode: null, stageSignal: "SIGKILL"});
    assert.equal(outcome.result, "failed");
    assert.equal(outcome.error, "browser stage was stopped by SIGKILL");
});

test("a flaky test that passed on retry is not a failure and a listed flaky test counts as passed", () => {
    const report = playwrightReport([
        t("chromium", SEEK, ["touch seeking", "fine-seek keeps destination"], "flaky"),
        t("webkit", SPEC, "reset refreshes the app shell", "unexpected"),
    ]);
    const outcome = classifyBrowserRun({entries, report, stageExitCode: 1});
    assert.equal(outcome.result, "passed_with_known_failures");
    assert.equal(outcome.listedPassed.length, 1);
    assert.equal(outcome.listedPassed[0].outcome, "flaky");
});

test("slowestPlaywrightTests ranks by results[].duration from a real Playwright JSON sample", () => {
    const samplePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "playwright-json-duration-sample.json");
    const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
    // The sample was copied from a real Playwright 1.64.1 run; duration lives on results[].
    assert.equal(sample.suites[0].suites[0].specs[0].tests[0].results[0].duration, 62);
    assert.equal(sample.stats.duration, 556.371);
    const collected = collectPlaywrightTests(sample);
    assert.equal(collected.ok, true);
    assert.equal(collected.tests.length, 1);
    assert.equal(collected.tests[0].durationMs, 62);
    assert.equal(collected.tests[0].title, "sample suite › tiny sample for duration shape");
    const ranked = slowestPlaywrightTests(sample, {limit: 10});
    assert.equal(ranked.ok, true);
    assert.deepEqual(ranked.tests, [{
        project: "chromium",
        file: "tiny.spec.ts",
        title: "sample suite › tiny sample for duration shape",
        durationMs: 62,
        status: "expected",
    }]);
});

test("slowestPlaywrightTests returns the longest 10 and keeps the max duration across repeats", () => {
    const tests = [
        {project: "chromium", file: SPEC, title: "a", status: "expected", duration: 100},
        {project: "chromium", file: SPEC, title: "b", status: "expected", duration: 5000},
        {project: "firefox", file: LAYOUT, title: "c", status: "expected", duration: 4000},
        // A second run of "b" keeps the longer duration when keys merge.
        {project: "chromium", file: SPEC, title: "b", status: "expected", duration: 9000},
        {project: "webkit", file: SPEC, title: "d", status: "expected", duration: 3000},
    ];
    for (let i = 1; i <= 8; i++) {
        tests.push({project: "chromium", file: SPEC, title: `extra ${i}`, status: "expected", duration: i * 10});
    }
    const ranked = slowestPlaywrightTests(playwrightReport(tests), {limit: 10});
    assert.equal(ranked.ok, true);
    assert.equal(ranked.tests.length, 10);
    assert.equal(ranked.tests[0].durationMs, 9000);
    assert.equal(ranked.tests[0].title, "b");
    assert.equal(ranked.tests[1].durationMs, 4000);
    // 12 distinct tests after merging the two "b" runs; the 10th is extra 3 at 30ms.
    assert.equal(ranked.tests.at(-1).durationMs, 30);
    assert.equal(ranked.tests.at(-1).title, "extra 3");
});

// --- Rerun alone (#792) ------------------------------------------------------------------------

const READER = "tests/e2e/reader-frame.spec.ts";
const failing = (project, file, title, line) => ({project, file, title, status: "unexpected", line});
const passing = (project, file, title, line) => ({project, file, title, status: "expected", line});
/** One rerun's input to applyReruns: its planned test and the report the rerun alone wrote. */
const rerun = (test, report) => ({test, report, reportError: report ? null : "Playwright JSON report was not written"});

test("rerun: a test that fails in the suite and passes alone is flaky, keeps its first error, and the run passes", () => {
    const gate = classifyBrowserRun({entries: [], report: playwrightReport([
        failing("chromium", READER, "long-press reaches a sentence", 125),
        passing("chromium", SPEC, "reset refreshes the app shell", 20),
    ]), stageExitCode: 1});
    assert.equal(gate.result, "failed");
    const plan = planReruns(gate);
    assert.equal(plan.skipped, null);
    assert.deepEqual(plan.tests.map((x) => [x.project, x.file, x.title, x.line]), [["chromium", READER, "long-press reaches a sentence", 125]]);
    const outcome = applyReruns(gate, [rerun(plan.tests[0], playwrightReport([passing("chromium", READER, "long-press reaches a sentence", 125)]))]);
    assert.equal(outcome.result, "passed_with_flaky");
    assert.deepEqual(outcome.newFailures, []);
    assert.deepEqual(outcome.flaky, [{project: "chromium", file: READER, title: "long-press reaches a sentence", firstError: "Error: expected 1"}]);
    assert.match(outcome.summary, /^passed_with_flaky: 0 known failures, 0 new, 1 flaky \(passed alone\)/);
});

test("rerun: a test that fails again alone stays a new failure and keeps the run red", () => {
    const gate = classifyBrowserRun({entries: [], report: playwrightReport([
        failing("chromium", READER, "long-press reaches a sentence", 125),
        failing("webkit", SPEC, "reset refreshes the app shell", 20),
    ]), stageExitCode: 1});
    const plan = planReruns(gate);
    assert.equal(plan.tests.length, 2);
    const outcome = applyReruns(gate, [
        rerun(plan.tests[0], playwrightReport([passing("chromium", READER, "long-press reaches a sentence", 125)])),
        rerun(plan.tests[1], playwrightReport([failing("webkit", SPEC, "reset refreshes the app shell", 20)])),
    ]);
    assert.equal(outcome.result, "failed");
    assert.deepEqual(outcome.newFailures.map((f) => [f.project, f.title, f.rerunError]), [["webkit", "reset refreshes the app shell", "Error: expected 1"]]);
    assert.deepEqual(outcome.flaky.map((f) => f.title), ["long-press reaches a sentence"]);
});

test("rerun: a rerun without a report, or whose report lacks the test, is not a pass", () => {
    const gate = classifyBrowserRun({entries: [], report: playwrightReport([failing("chromium", READER, "long-press reaches a sentence", 125)]), stageExitCode: 1});
    const [planned] = planReruns(gate).tests;
    for (const [name, input, pattern] of [
        ["no report", rerun(planned, null), /not written/],
        ["other test only", rerun(planned, playwrightReport([passing("chromium", READER, "another test", 125)])), /did not run this test/],
        ["other project", rerun(planned, playwrightReport([passing("firefox", READER, "long-press reaches a sentence", 125)])), /did not run this test/],
        ["skipped alone", rerun(planned, playwrightReport([{...passing("chromium", READER, "long-press reaches a sentence", 125), status: "skipped"}])), /skipped/],
    ]) {
        const outcome = applyReruns(gate, [input]);
        assert.equal(outcome.result, "failed", name);
        assert.match(outcome.newFailures[0].rerunError, pattern, name);
    }
});

test("rerun: above the bound nothing is rerun and the run fails as before", () => {
    assert.equal(DEFAULT_MAX_RERUNS, 12);
    const many = (count) => classifyBrowserRun({entries: [], report: playwrightReport(
        Array.from({length: count}, (_, i) => failing("chromium", SPEC, `test ${i}`, 10 + i))), stageExitCode: 1});
    assert.equal(planReruns(many(12)).tests.length, 12, "exactly the bound is still rerun");
    const over = planReruns(many(13));
    assert.deepEqual(over.tests, []);
    assert.match(over.skipped, /13 failures exceed the rerun bound of 12/);
    assert.deepEqual(planReruns(many(3), {max: 2}).tests, []);
    assert.match(planReruns(many(1), {max: 0}).skipped, /off/);
});

test("rerun: only unlisted failures of a report that accounts for them are rerun", () => {
    const listedOnly = classifyBrowserRun({entries, report: playwrightReport([failing("webkit", SPEC, "reset refreshes the app shell", 20)]), stageExitCode: 1});
    assert.equal(listedOnly.result, "passed_with_known_failures");
    assert.deepEqual(planReruns(listedOnly), {tests: [], skipped: null});
    const runLevel = classifyBrowserRun({entries: [], report: playwrightReport([failing("chromium", READER, "x", 5)], {errors: [{message: "webServer exited"}]}), stageExitCode: 1});
    assert.deepEqual(planReruns(runLevel).tests, [], "a run-level error is never rerun away");
    const interrupted = classifyBrowserRun({entries: [], report: playwrightReport([{project: "chromium", file: READER, title: "x", status: "interrupted"}]), stageExitCode: 1});
    assert.deepEqual(planReruns(interrupted).tests, []);
    const mixed = classifyBrowserRun({entries, report: playwrightReport([
        failing("webkit", SPEC, "reset refreshes the app shell", 20),
        failing("chromium", READER, "long-press reaches a sentence", 125),
    ]), stageExitCode: 1});
    const plan = planReruns(mixed);
    assert.deepEqual(plan.tests.map((x) => x.title), ["long-press reaches a sentence"]);
    const outcome = applyReruns(mixed, [rerun(plan.tests[0], playwrightReport([passing("chromium", READER, "long-press reaches a sentence", 125)]))]);
    assert.equal(outcome.result, "passed_with_flaky", "known plus flaky passes, named as flaky");
    assert.equal(outcome.knownFailures.length, 1);
    assert.equal(outcome.flaky.length, 1);
});

test("rerun: the Playwright arguments run one test alone in its own project", () => {
    assert.deepEqual(rerunPlaywrightArgs({project: "mobile-chrome", file: "tests/e2e/reader-frame.spec.ts", line: 125}, 3), [
        "--workers=1", "--retries=0", "--project=mobile-chrome", "--reporter=list,json",
        "--output=test-results-rerun-3", "tests/e2e/reader-frame\\.spec\\.ts:125",
    ]);
    assert.equal(rerunPlaywrightArgs({project: "chromium", file: "tests/e2e/a.spec.ts", line: null}, 1).at(-1), "tests/e2e/a\\.spec\\.ts$");
});

test("rerun: the summary lists new, flaky and known with one line per test, under 30 lines", () => {
    const gate = classifyBrowserRun({entries, report: playwrightReport([
        failing("webkit", SPEC, "reset refreshes the app shell", 20),
        failing("chromium", READER, "passes alone", 30),
        failing("chromium", READER, "fails again", 40),
    ]), stageExitCode: 1});
    const plan = planReruns(gate);
    const outcome = applyReruns(gate, [
        rerun(plan.tests[0], playwrightReport([passing("chromium", READER, "passes alone", 30)])),
        rerun(plan.tests[1], playwrightReport([failing("chromium", READER, "fails again", 40)])),
    ]);
    assert.deepEqual(browserSummaryLines(outcome), [
        outcome.summary,
        "new failures (1):",
        `  chromium ${READER} › fails again — Error: expected 1`,
        "flaky (passed alone) (1):",
        `  chromium ${READER} › passes alone — Error: expected 1`,
        "known (1):",
        `  webkit ${SPEC} › reset refreshes the app shell — environment #37`,
    ]);
    const crowded = classifyBrowserRun({entries: [], report: playwrightReport(
        Array.from({length: 40}, (_, i) => failing("chromium", SPEC, `test ${i}`, i + 1))), stageExitCode: 1});
    const lines = browserSummaryLines(crowded);
    assert.equal(lines.length, 29);
    assert.match(lines.at(-1), /and 14 more lines/);
});

test("collectPlaywrightTests keeps each test's line so the rerun can select it", () => {
    const collected = collectPlaywrightTests(playwrightReport([failing("chromium", READER, "x", 77), passing("chromium", READER, "y", undefined)]));
    assert.deepEqual(collected.tests.map((x) => x.line), [77, 11]);
});
