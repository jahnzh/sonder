#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseUnitFailures(text) {
  if (!text) return [];
  const failures = [];

  // Look for Node test runner spec reporter "✖ failing tests:"
  const specMatch = text.match(/[✖X]\s+failing tests:/i);
  if (specMatch && specMatch.index !== undefined) {
    const section = text.slice(specMatch.index + specMatch[0].length);
    const lines = section.split("\n");
    let currentTest = null;
    let currentError = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // A failing test line starts with ✖ or X
      const testMatch = line.match(/^[✖X]\s+(.*?)(?:\s+\([^)]+\))?$/);
      if (testMatch) {
        if (currentTest) {
          failures.push({ name: currentTest, error: currentError || "failed" });
        }
        currentTest = testMatch[1].trim();
        currentError = null;
        continue;
      }
      // If we are tracking a test, grab the first non-empty line of error
      if (currentTest && currentError === null) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("test at ") && !trimmed.startsWith("✖") && !trimmed.startsWith("X ")) {
          currentError = trimmed;
        }
      }
    }
    if (currentTest) {
      failures.push({ name: currentTest, error: currentError || "failed" });
    }
  }

  // Look for TAP reporter lines (e.g. "not ok 1 - test name") if no spec failures found
  if (failures.length === 0) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const tapMatch = line.match(/^not ok \d+ - (.*?)(?: #.*)?$/);
      if (tapMatch) {
        const testName = tapMatch[1].trim();
        let errMsg = "failed";
        for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
          const l = lines[j].trim();
          if (l.startsWith("not ok ") || l.startsWith("ok ")) break;
          const msgMatch = l.match(/(?:error|message|AssertionError):\s*['"]?(.*?)['"]?$/i);
          if (msgMatch) {
            errMsg = msgMatch[0];
            break;
          }
        }
        failures.push({ name: testName, error: errMsg });
      }
    }
  }

  // Fallback: search for top-level error in text if unit stage failed
  if (failures.length === 0) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const errLine = lines.find(
      (l) => l.startsWith("AssertionError") || l.startsWith("Error:") || l.includes("Error:"),
    );
    if (errLine) {
      failures.push({ name: "unit", error: errLine });
    }
  }

  return failures;
}

export function extractArtifactDirFromText(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/(?:\[ci-(?:ssh|deck)\]\s+)?Artifacts:\s*([^\r\n]+)/g)];
  if (matches.length > 0) {
    const rawPath = matches[matches.length - 1][1].trim();
    if (fs.existsSync(rawPath)) {
      return path.resolve(rawPath);
    }
    const rel = path.resolve(process.cwd(), rawPath);
    if (fs.existsSync(rel)) {
      return rel;
    }
    return rawPath;
  }
  return null;
}

export function resolveArtifactDir(input) {
  if (!input || input === "-") {
    try {
      const stdin = fs.readFileSync(0, "utf8");
      return resolveFromTextOrPath(stdin.trim());
    } catch {
      return null;
    }
  }
  return resolveFromTextOrPath(input);
}

function resolveFromTextOrPath(textOrPath) {
  if (!textOrPath) return null;

  if (fs.existsSync(textOrPath)) {
    const stat = fs.statSync(textOrPath);
    if (stat.isDirectory()) {
      // Check if this directory itself contains report files
      if (
        fs.existsSync(path.join(textOrPath, "check-report.json")) ||
        fs.existsSync(path.join(textOrPath, "report.json")) ||
        fs.existsSync(path.join(textOrPath, "ci-ssh-result.txt")) ||
        fs.existsSync(path.join(textOrPath, "ci-deck-result.txt"))
      ) {
        return path.resolve(textOrPath);
      }
      // Check subdirectories for a matching run directory
      const entries = fs.readdirSync(textOrPath, { withFileTypes: true });
      const subdirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(textOrPath, e.name))
        .filter(
          (d) =>
            fs.existsSync(path.join(d, "check-report.json")) ||
            fs.existsSync(path.join(d, "report.json")) ||
            fs.existsSync(path.join(d, "ci-ssh-result.txt")) ||
            fs.existsSync(path.join(d, "ci-deck-result.txt")),
        );
      if (subdirs.length > 0) {
        subdirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return path.resolve(subdirs[0]);
      }
      return path.resolve(textOrPath);
    }

    if (stat.isFile()) {
      const base = path.basename(textOrPath);
      if (
        base === "check-report.json" ||
        base === "report.json" ||
        base === "ci-ssh-result.txt" ||
        base === "ci-deck-result.txt"
      ) {
        return path.resolve(path.dirname(textOrPath));
      }
      const content = fs.readFileSync(textOrPath, "utf8");
      const extracted = extractArtifactDirFromText(content);
      if (extracted) return extracted;
    }
  }

  // String itself might contain the Artifacts: log line
  const extracted = extractArtifactDirFromText(textOrPath);
  if (extracted) return extracted;

  return null;
}

export function summarizeRun(artifactDir) {
  if (!artifactDir || !fs.existsSync(artifactDir)) {
    throw new Error(`Artifact directory not found: ${artifactDir}`);
  }

  const resultInfo = {};
  const sshResultPath = path.join(artifactDir, "ci-ssh-result.txt");
  const deckResultPath = path.join(artifactDir, "ci-deck-result.txt");
  let resultFilePath = null;
  if (fs.existsSync(sshResultPath)) {
    resultFilePath = sshResultPath;
  } else if (fs.existsSync(deckResultPath)) {
    resultFilePath = deckResultPath;
  }

  if (resultFilePath) {
    const content = fs.readFileSync(resultFilePath, "utf8");
    for (const line of content.split("\n")) {
      const idx = line.indexOf("=");
      if (idx !== -1) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        resultInfo[k] = v;
      }
    }
  }

  let report = null;
  const checkReportPath = path.join(artifactDir, "check-report.json");
  const altReportPath = path.join(artifactDir, "report.json");
  if (fs.existsSync(checkReportPath)) {
    report = JSON.parse(fs.readFileSync(checkReportPath, "utf8"));
  } else if (fs.existsSync(altReportPath)) {
    report = JSON.parse(fs.readFileSync(altReportPath, "utf8"));
  }

  if (!report && !resultFilePath) {
    throw new Error(`Neither check-report.json nor result file found under ${artifactDir}`);
  }

  const commit =
    resultInfo.commit || report?.sha || report?.resolvedRef || report?.requestedRef || "unknown";

  let host = resultInfo.host;
  if (!host) {
    if (resultFilePath === deckResultPath) host = "deck@steamdeck";
    else if (resultFilePath === sshResultPath) host = "192.168.1.119";
    else host = report?.host || "unknown";
  }

  const result = resultInfo.result || report?.finalResult || report?.result || "unknown";

  // Stages
  let stages = [];
  if (report && Array.isArray(report.stages) && report.stages.length > 0) {
    stages = report.stages.map((s) => ({
      name: s.name,
      status: s.status,
      durationMs: typeof s.durationMs === "number" ? s.durationMs : null,
    }));
  } else if (report?.setup?.status === "failed") {
    stages = [{ name: "setup", status: "failed", durationMs: report.setup?.durationMs ?? null }];
  } else if (report?.failedStage) {
    const standard = ["install", "build", "unit", "browser"];
    let failedSeen = false;
    stages = standard.map((name) => {
      if (name === report.failedStage) {
        failedSeen = true;
        return { name, status: "failed", durationMs: null };
      }
      return { name, status: failedSeen ? "skipped" : "passed", durationMs: null };
    });
  } else if (report?.knownFailures?.new?.length > 0 || report?.knownFailures?.result === "failed") {
    stages = [
      { name: "install", status: "passed", durationMs: null },
      { name: "build", status: "passed", durationMs: null },
      { name: "unit", status: "passed", durationMs: null },
      { name: "browser", status: "failed", durationMs: null },
    ];
  } else if (report?.ok === true || result === "passed" || result === "passed_with_known_failures") {
    stages = [
      { name: "install", status: "passed", durationMs: null },
      { name: "build", status: "passed", durationMs: null },
      { name: "unit", status: "passed", durationMs: null },
      { name: "browser", status: "passed", durationMs: null },
    ];
  }

  // Browser failures
  let newBrowserFailures = [];
  let knownBrowserFailures = [];
  if (report?.knownFailures) {
    if (Array.isArray(report.knownFailures.new)) {
      newBrowserFailures = report.knownFailures.new;
    }
    if (Array.isArray(report.knownFailures.known)) {
      knownBrowserFailures = report.knownFailures.known;
    }
  }

  // Unit failures
  let unitFailures = [];
  const unitStage = report?.stages?.find((s) => s.name === "unit");
  const unitFailed = unitStage ? unitStage.status === "failed" : report?.failedStage === "unit";

  if (unitFailed) {
    let unitOutput = unitStage?.stdout || "";
    if (unitStage?.stderr) unitOutput += "\n" + unitStage.stderr;

    const unitLogPath = path.join(artifactDir, unitStage?.logFile || "stage-3-unit.log");
    if ((!unitOutput || unitOutput.trim() === "") && fs.existsSync(unitLogPath)) {
      unitOutput = fs.readFileSync(unitLogPath, "utf8");
    }

    unitFailures = parseUnitFailures(unitOutput);
  }

  // Slowest browser tests
  let browserSlowestTests = [];
  if (report && Array.isArray(report.browserSlowestTests)) {
    browserSlowestTests = report.browserSlowestTests;
  }

  return {
    commit,
    host,
    result,
    stages,
    newBrowserFailures,
    knownBrowserFailures,
    unitFailures,
    unitFailed,
    browserSlowestTests,
  };
}

export function formatSummary(data) {
  const lines = [];
  lines.push(`commit: ${data.commit}`);
  lines.push(`host: ${data.host}`);
  lines.push(`result: ${data.result}`);

  lines.push("stages:");
  if (data.stages.length > 0) {
    for (const stage of data.stages) {
      const dur =
        typeof stage.durationMs === "number"
          ? ` (${(stage.durationMs / 1000).toFixed(1)}s)`
          : "";
      lines.push(`  ${stage.name}: ${stage.status}${dur}`);
    }
  } else {
    lines.push("  unknown");
  }

  // New browser failures
  if (data.newBrowserFailures.length === 0) {
    lines.push("new browser failures: 0");
  } else {
    lines.push(`new browser failures (${data.newBrowserFailures.length}):`);
    for (const f of data.newBrowserFailures) {
      const issuePart = f.issue ? ` (#${f.issue})` : "";
      const text = `${f.project || ""} ${f.file || ""} ${f.title || ""}${issuePart}`.trim();
      lines.push(`  ${text}`);
    }
  }

  // Known browser failures
  if (data.knownBrowserFailures.length === 0) {
    lines.push("known browser failures: 0");
  } else {
    lines.push(`known browser failures (${data.knownBrowserFailures.length}):`);
    for (const f of data.knownBrowserFailures) {
      const issueStr = f.issue
        ? String(f.issue).startsWith("#")
          ? `(${f.issue})`
          : `(#${f.issue})`
        : "(#unknown)";
      const text = `${f.project || ""} ${f.file || ""} ${f.title || ""} ${issueStr}`.trim();
      lines.push(`  ${text}`);
    }
  }

  // Unit failures (for failed unit stage)
  if (data.unitFailed) {
    if (data.unitFailures.length === 0) {
      lines.push("unit failures: failed (no individual test failures detected)");
    } else {
      lines.push(`unit failures (${data.unitFailures.length}):`);
      for (const u of data.unitFailures) {
        lines.push(`  ${u.name}: ${u.error}`);
      }
    }
  }

  // Slowest browser tests
  if (data.browserSlowestTests && data.browserSlowestTests.length > 0) {
    const top = data.browserSlowestTests.slice(0, 5);
    lines.push(`slowest browser tests (${top.length}):`);
    for (const entry of top) {
      const sec =
        typeof entry.durationMs === "number"
          ? `${(entry.durationMs / 1000).toFixed(1)}s `
          : "";
      const proj = entry.project ? `${entry.project} ` : "";
      const file = entry.file || "";
      const title = entry.title ? ` › ${entry.title}` : "";
      lines.push(`  ${sec}${proj}${file}${title}`.trimEnd());
    }
  }

  // Enforce under 30 lines ceiling
  if (lines.length >= 30) {
    const kept = lines.slice(0, 28);
    const omitted = lines.length - 28;
    kept.push(`  ... and ${omitted} more lines truncated (< 30 lines limit)`);
    return kept.join("\n");
  }

  return lines.join("\n");
}

function printUsage() {
  console.log("usage: scripts/ci-summary.sh <ci-log | artifact dir>");
  console.log("");
  console.log("Summarises a CI run in under 30 lines: commit, host, stages with status,");
  console.log("the new and known browser failures (project, file, title, issue), and for");
  console.log("a failed unit stage the failing test names with the first lines of each error.");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  const input = args[0];
  if (!input && process.stdin.isTTY) {
    printUsage();
    process.exit(2);
  }

  const artifactDir = resolveArtifactDir(input);
  if (!artifactDir || !fs.existsSync(artifactDir)) {
    console.error(`ci-summary: artifact directory not found: ${input || "<stdin>"}`);
    process.exit(2);
  }

  try {
    const data = summarizeRun(artifactDir);
    const summary = formatSummary(data);
    console.log(summary);
  } catch (err) {
    console.error(`ci-summary: ${err.message}`);
    process.exit(2);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main();
}
