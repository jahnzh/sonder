import fs from "node:fs";
import path from "node:path";

export const KNOWN_FAILURE_KINDS = ["environment", "intermittent"];

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function entryKey(project, file, title) {
  return JSON.stringify([project, file, title]);
}

function describeEntry(entry) {
  return `${entry.project} ${entry.file} "${entry.title}"`;
}

/**
 * Validate a parsed known-failures document (version 1). Returns the entries or the first problem found.
 */
export function validateKnownFailures(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, error: "expected a JSON object" };
  }
  if (document.version !== 1) {
    return { ok: false, error: `unsupported version ${JSON.stringify(document.version)} (expected 1)` };
  }
  if (!Array.isArray(document.entries)) {
    return { ok: false, error: '"entries" must be an array' };
  }

  const seen = new Set();
  const entries = [];
  for (const [index, raw] of document.entries.entries()) {
    const where = `entries[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `${where} must be an object` };
    }
    for (const field of ["project", "file", "title", "reason"]) {
      if (typeof raw[field] !== "string" || raw[field].trim() === "") {
        return { ok: false, error: `${where}.${field} must be a non-empty string` };
      }
    }
    if (!KNOWN_FAILURE_KINDS.includes(raw.kind)) {
      return { ok: false, error: `${where}.kind must be one of ${KNOWN_FAILURE_KINDS.join(", ")}` };
    }
    if (raw.issue !== undefined && !(Number.isInteger(raw.issue) && raw.issue > 0)) {
      return { ok: false, error: `${where}.issue must be a positive integer when present` };
    }
    const key = entryKey(raw.project, raw.file, raw.title);
    if (seen.has(key)) return { ok: false, error: `${where} duplicates ${describeEntry(raw)}` };
    seen.add(key);
    entries.push({
      project: raw.project,
      file: raw.file,
      title: raw.title,
      kind: raw.kind,
      reason: raw.reason,
      ...(raw.issue === undefined ? {} : { issue: raw.issue }),
    });
  }
  return { ok: true, entries };
}

/**
 * Read and validate a known-failures file. Never throws: a missing, unreadable or malformed file is an error result.
 */
export function loadKnownFailures(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: `cannot read ${filePath}: ${error.message}` };
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${filePath} is not valid JSON: ${error.message}` };
  }
  const validated = validateKnownFailures(document);
  if (!validated.ok) return { ok: false, error: `${filePath}: ${validated.error}` };
  return { ok: true, entries: validated.entries };
}

function firstLine(message) {
  const line = String(message ?? "").replace(ANSI_PATTERN, "").split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, 300);
}

/**
 * Flatten a Playwright JSON report into one record per (project, file, title).
 * `file` is relative to the directory holding the Playwright config, so it matches repository paths.
 * Returns an error if the document does not look like a Playwright JSON report.
 */
export function collectPlaywrightTests(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.suites) || !Array.isArray(report.errors)
      || !report.stats || typeof report.stats !== "object") {
    return { ok: false, error: "not a Playwright JSON report (missing suites, errors or stats)" };
  }
  const config = report.config ?? {};
  const rootDir = typeof config.rootDir === "string" ? config.rootDir : null;
  const configDir = typeof config.configFile === "string" ? path.dirname(config.configFile) : null;

  const repoPath = (specFile) => {
    if (!rootDir || !configDir) return specFile;
    return path.relative(configDir, path.resolve(rootDir, specFile)).split(path.sep).join("/");
  };

  const byKey = new Map();
  let malformed = null;
  const visit = (suite, titles, isRoot) => {
    if (!suite || typeof suite !== "object") { malformed = "suite is not an object"; return; }
    // A top-level suite is the spec file itself; deeper suites are describe blocks.
    const trail = isRoot ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (typeof spec.file !== "string" || typeof spec.title !== "string" || typeof test.projectName !== "string") {
          malformed = "spec without file, title or project name";
          return;
        }
        const results = Array.isArray(test.results) ? test.results : [];
        const last = results[results.length - 1];
        // Playwright reports an interrupted test as status "skipped" with an "interrupted" result.
        const interrupted = last?.status === "interrupted";
        const failed = test.status === "unexpected" || interrupted;
        const title = [...trail, spec.title].join(" › ");
        // results[].duration is milliseconds; shape taken from a real Playwright 1.64 JSON report.
        const durationMs = Number.isFinite(last?.duration) ? last.duration : null;
        const record = {
          project: test.projectName,
          file: repoPath(spec.file),
          title,
          status: test.status,
          failed,
          interrupted,
          durationMs,
          message: failed ? firstLine(last?.error?.message ?? last?.errors?.[0]?.message) : "",
        };
        const key = entryKey(record.project, record.file, record.title);
        const previous = byKey.get(key);
        // Repeated tests under one key fail if any repetition failed; keep the longest duration.
        if (!previous) {
          byKey.set(key, record);
        } else {
          const prefer = record.failed && !previous.failed ? record : previous;
          const duration = Math.max(
            Number.isFinite(previous.durationMs) ? previous.durationMs : -1,
            Number.isFinite(record.durationMs) ? record.durationMs : -1,
          );
          byKey.set(key, {
            ...prefer,
            durationMs: duration >= 0 ? duration : null,
          });
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, trail, false);
  };
  for (const suite of report.suites) visit(suite, [], true);
  if (malformed) return { ok: false, error: `malformed Playwright report: ${malformed}` };

  return { ok: true, tests: [...byKey.values()], errors: report.errors, stats: report.stats };
}

/**
 * Rank Playwright JSON-report tests by results[].duration (ms), longest first.
 * Returns up to `limit` entries for the check report summary.
 */
export function slowestPlaywrightTests(report, {limit = 10} = {}) {
  const collected = collectPlaywrightTests(report);
  if (!collected.ok) return collected;
  const tests = collected.tests
    .filter((t) => Number.isFinite(t.durationMs))
    .sort((a, b) => b.durationMs - a.durationMs || a.title.localeCompare(b.title))
    .slice(0, Math.max(0, limit))
    .map(({project, file, title, durationMs, status}) => ({project, file, title, durationMs, status}));
  return {ok: true, tests};
}

/**
 * Read a Playwright JSON report from disk and return its slowest tests.
 */
export function readSlowestPlaywrightTests(reportPath, {limit = 10} = {}) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: error.code === "ENOENT"
        ? "Playwright JSON report was not written"
        : `Playwright JSON report is unreadable: ${error.message}`,
      tests: [],
    };
  }
  const ranked = slowestPlaywrightTests(report, {limit});
  if (!ranked.ok) return {...ranked, tests: []};
  return ranked;
}

function outcomeOf(test) {
  if (!test) return "not_run";
  if (test.failed) return "failed";
  if (test.status === "expected") return "passed";
  return test.status === "flaky" ? "flaky" : "skipped";
}

/**
 * Decide the browser stage result against the known-failures entries.
 *
 * `failed`: the stage exited non-zero and its report is unusable, has run-level errors, shows no failing test,
 * disagrees with its own counts, or contains any failure that is not listed.
 * `passed_with_known_failures`: the stage exited non-zero and every failure is listed.
 * `passed`: the stage exited zero.
 *
 * `report` may be null when the JSON file is absent; `reportError` then says why.
 */
export function classifyBrowserRun({ entries, report, reportError = null, stageExitCode, stageSignal = null }) {
  const collected = report ? collectPlaywrightTests(report) : { ok: false, error: reportError ?? "Playwright JSON report was not written" };
  // A stage stopped by a signal did not finish, so it can never pass and its failures are never tolerated.
  const stagePassed = stageExitCode === 0 && !stageSignal;
  const signalError = stageSignal ? `browser stage was stopped by ${stageSignal}` : null;

  const empty = { knownFailures: [], newFailures: [], listedPassed: [], listedNotRun: [] };
  if (!collected.ok) {
    return {
      ...empty,
      result: stagePassed ? "passed" : "failed",
      error: signalError ?? collected.error,
      summary: summarize(stagePassed ? "passed" : "failed", empty, signalError ?? collected.error),
    };
  }

  const byKey = new Map(collected.tests.map((t) => [entryKey(t.project, t.file, t.title), t]));
  const failures = collected.tests.filter((t) => t.failed);
  const listed = new Map(entries.map((e) => [entryKey(e.project, e.file, e.title), e]));

  const knownFailures = [];
  const newFailures = [];
  for (const failure of failures) {
    // An interrupted test did not finish: it is never a known failure, even if it is listed.
    const entry = failure.interrupted ? null : listed.get(entryKey(failure.project, failure.file, failure.title));
    if (entry) knownFailures.push({ ...entry, message: failure.message });
    else newFailures.push({ project: failure.project, file: failure.file, title: failure.title, message: failure.message });
  }

  const listedPassed = [];
  const listedNotRun = [];
  for (const entry of entries) {
    const outcome = outcomeOf(byKey.get(entryKey(entry.project, entry.file, entry.title)));
    if (outcome === "passed" || outcome === "flaky") listedPassed.push({ ...entry, outcome });
    else if (outcome === "not_run" || outcome === "skipped") listedNotRun.push({ ...entry, outcome });
  }
  const parts = { knownFailures, newFailures, listedPassed, listedNotRun };

  if (stagePassed) {
    return { ...parts, result: "passed", error: null, summary: summarize("passed", parts, null) };
  }

  let error = signalError;
  const interruptedCount = failures.filter((t) => t.interrupted).length;
  if (error) {
    // already decided
  } else if (interruptedCount > 0) {
    error = `${interruptedCount} test(s) were interrupted, so the run did not finish`;
  } else if (collected.errors.length > 0) {
    error = `Playwright reported ${collected.errors.length} run-level error(s): ${firstLine(collected.errors[0]?.message)}`;
  } else if (failures.length === 0) {
    error = "browser stage failed but the report shows no failing test";
  } else if (Number.isInteger(collected.stats.unexpected)
      && collected.tests.filter((t) => t.status === "unexpected").length !== collected.stats.unexpected) {
    error = "report counts disagree with the tests it lists";
  }

  const result = error || newFailures.length > 0 ? "failed" : "passed_with_known_failures";
  return { ...parts, result, error, summary: summarize(result, parts, error) };
}

function summarize(result, { knownFailures, newFailures, listedPassed, listedNotRun }, error) {
  const byKind = KNOWN_FAILURE_KINDS
    .map((kind) => [kind, knownFailures.filter((f) => f.kind === kind).length])
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  const known = `${knownFailures.length} known failure${knownFailures.length === 1 ? "" : "s"}${byKind.length ? ` (${byKind.join(", ")})` : ""}`;
  const stale = `${listedPassed.length} listed test${listedPassed.length === 1 ? "" : "s"} passed`
    + (listedNotRun.length ? `, ${listedNotRun.length} not run` : "");
  return `${result}: ${known}, ${newFailures.length} new; ${stale}${error ? `; ${error}` : ""}`;
}

/**
 * Read the stage's Playwright JSON report from disk and classify it.
 */
export function evaluateBrowserRun({ entries, reportPath, stageExitCode, stageSignal = null }) {
  let report = null;
  let reportError = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    reportError = error.code === "ENOENT"
      ? "Playwright JSON report was not written"
      : `Playwright JSON report is unreadable: ${error.message}`;
  }
  return classifyBrowserRun({ entries, report, reportError, stageExitCode, stageSignal });
}
