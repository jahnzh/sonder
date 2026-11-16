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
} from "../scripts/known-failures.mjs";
import { playwrightReport, knownFailuresDocument } from "./playwright-report-fixture.mjs";

const SPEC = "tests/e2e/device-reset.spec.ts";
const LAYOUT = "tests/e2e/now-playing-layout.spec.ts";
const SEEK = "tests/e2e/playback-workflow.spec.ts";

/** Every triple here must stay in tests/known-failures.wsl-host.json; the file may add more. */
const WSL_HOST_REQUIRED_ENTRIES = [
    {project: "chromium", file: "tests/e2e/playback-workflow.spec.ts", title: "touch seeking › releasing a fine-seek gesture keeps the exact previewed destination"},
    {project: "chromium", file: "tests/e2e/reader-theme.spec.ts", title: "a 409 with no server checkpoint rebases to revision 0 and saves instead of looping"},
    {project: "chromium", file: "tests/e2e/reader-frame.spec.ts", title: "a failed event probe enables scripts while the content defences still block them"},
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
