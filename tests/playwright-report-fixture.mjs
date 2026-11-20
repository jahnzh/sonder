// Builds Playwright JSON reports (reporter "json") for tests. Shape checked against a real run of this repo's suite.
const ROOT = "/work/sonder";

/**
 * `tests` are {project, file, title, status} with `title` as a string or an array of describe titles ending in the test title,
 * `file` as a repository path such as "tests/e2e/x.spec.ts", status "expected", "unexpected", "flaky" or "skipped",
 * and an optional `line` (default: 10 plus the test's index in its file).
 */
export function playwrightReport(tests, {errors = [], stats = null} = {}) {
    const byFile = new Map();
    for (const t of tests) {
        const titles = Array.isArray(t.title) ? t.title : [t.title];
        if (!byFile.has(t.file))
            byFile.set(t.file, []);
        byFile.get(t.file).push({...t, titles});
    }
    const suites = [];
    for (const [file, fileTests] of byFile) {
        const specFile = file.replace(/^tests\/e2e\//, "");
        const root = {title: specFile, file: specFile, specs: [], suites: []};
        for (const t of fileTests) {
            let suite = root;
            for (const describeTitle of t.titles.slice(0, -1)) {
                let child = suite.suites.find((s) => s.title === describeTitle);
                if (!child) {
                    child = {title: describeTitle, file: specFile, specs: [], suites: []};
                    suite.suites.push(child);
                }
                suite = child;
            }
            const failed = t.status === "unexpected";
            // "interrupted" is how Playwright reports a test that never finished: test status "skipped", result status "interrupted".
            const interrupted = t.status === "interrupted";
            const resultStatus = interrupted ? "interrupted" : failed ? "failed" : t.status === "skipped" ? "skipped" : "passed";
            suite.specs.push({
                title: t.titles[t.titles.length - 1],
                ok: !failed,
                file: specFile,
                // Real reports give every spec its line and column; a rerun selects the test by `file:line`.
                line: Number.isInteger(t.line) ? t.line : 10 + fileTests.indexOf(t),
                column: 3,
                tests: [{
                    projectName: t.project,
                    projectId: t.project,
                    expectedStatus: t.status === "skipped" || interrupted ? "skipped" : "passed",
                    status: interrupted ? "skipped" : t.status,
                    results: [{
                        status: resultStatus,
                        duration: Number.isFinite(t.duration) ? t.duration : 0,
                        errors: failed ? [{message: "Error: \u001b[31mexpected\u001b[39m 1\nsecond line"}] : [],
                        ...(failed ? {error: {message: "Error: \u001b[31mexpected\u001b[39m 1\nsecond line"}} : {}),
                    }],
                }],
            });
        }
        suites.push(root);
    }
    const count = (status) => tests.filter((t) => (t.status === "interrupted" ? "skipped" : t.status) === status).length;
    return {
        config: {configFile: `${ROOT}/playwright.config.ts`, rootDir: `${ROOT}/tests/e2e`},
        suites,
        errors,
        stats: stats ?? {expected: count("expected"), skipped: count("skipped"), unexpected: count("unexpected"), flaky: count("flaky")},
    };
}

export function knownFailuresDocument(entries) {
    return {
        version: 1,
        entries: entries.map((e) => ({kind: "environment", reason: "test reason", issue: 37, ...e})),
    };
}
