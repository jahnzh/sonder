#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

/**
 * Returns the current reference time, respecting SONDER_NOW and DATE_CMD.
 */
export function getNow(nowArg) {
  if (nowArg) {
    const d = new Date(nowArg);
    if (!isNaN(d.getTime())) return d;
  }
  if (process.env.SONDER_NOW) {
    const d = new Date(process.env.SONDER_NOW);
    if (!isNaN(d.getTime())) return d;
  }
  if (process.env.DATE_CMD) {
    try {
      const out = execSync(process.env.DATE_CMD, { encoding: "utf8" }).trim();
      const d = new Date(out);
      if (!isNaN(d.getTime())) return d;
    } catch {
      // ignore error from fake DATE_CMD
    }
  }
  return new Date();
}

/**
 * Extracts a date (YYYY-MM-DD) from a line, or null if not found.
 */
export function extractDateFromLine(line) {
  const m = line.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

/**
 * Extracts timestamp from a line, or null if not found.
 */
export function extractTimestampFromLine(line, currentDate) {
  // ISO datetime e.g. 2026-11-07T06:20:00Z or 2026-11-07 06:20Z
  const isoMatch = line.match(/\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)\s*Z?\b/);
  if (isoMatch) {
    const timePart = isoMatch[2].length === 5 ? isoMatch[2] + ":00" : isoMatch[2];
    const d = new Date(`${isoMatch[1]}T${timePart}Z`);
    if (!isNaN(d.getTime())) return { date: isoMatch[1], timestamp: d };
  }

  // Bullet with time only e.g. "- 19:30Z" or "- 05:36Z"
  const timeOnlyMatch = line.match(/^[-*]\s+(\d{2}:\d{2}(?::\d{2})?)\s*Z?\b/);
  if (timeOnlyMatch && currentDate) {
    const timePart = timeOnlyMatch[1].length === 5 ? timeOnlyMatch[1] + ":00" : timeOnlyMatch[1];
    const d = new Date(`${currentDate}T${timePart}Z`);
    if (!isNaN(d.getTime())) return { date: currentDate, timestamp: d };
  }

  // Date only in heading or text
  const dateOnly = extractDateFromLine(line);
  if (dateOnly) {
    return { date: dateOnly, timestamp: null };
  }

  return null;
}

/**
 * Splits lines into pinned "current" section (<= 60 lines) and the rest.
 */
export function splitPinnedSection(lines) {
  // Check if there is an explicit "# Current" heading
  let currentHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s+current\b/i.test(lines[i])) {
      currentHeaderIdx = i;
      break;
    }
  }

  if (currentHeaderIdx !== -1) {
    let endIdx = currentHeaderIdx + 1;
    const maxEnd = Math.min(lines.length, currentHeaderIdx + 60);
    while (endIdx < maxEnd) {
      const line = lines[endIdx];
      if (/^#{1,4}\s+/.test(line) && extractDateFromLine(line)) {
        break;
      }
      if (/^[-*]\s+/.test(line) && extractTimestampFromLine(line, null)) {
        break;
      }
      endIdx++;
    }
    return { pinned: lines.slice(0, endIdx), rest: lines.slice(endIdx) };
  }

  // Check if file starts with non-dated preamble before any dated header or bullet
  let firstDatedIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,4}\s+/.test(line) && extractDateFromLine(line)) {
      firstDatedIdx = i;
      break;
    }
    if (/^[-*]\s+/.test(line) && extractTimestampFromLine(line, null)) {
      firstDatedIdx = i;
      break;
    }
  }

  if (firstDatedIdx > 0) {
    const pinEnd = Math.min(firstDatedIdx, 60);
    return { pinned: lines.slice(0, pinEnd), rest: lines.slice(pinEnd) };
  }

  if (firstDatedIdx === 0) {
    return { pinned: [], rest: lines };
  }

  // No dated lines at all
  return { pinned: lines.slice(0, Math.min(lines.length, 60)), rest: lines.slice(Math.min(lines.length, 60)) };
}

/**
 * Parses lines into sections, each containing items.
 */
function parseSections(lines) {
  const sections = [];
  let currentSection = {
    headerLine: null,
    date: null,
    items: [],
  };

  let activeDate = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeader = /^#{1,6}\s+/.test(line);

    if (isHeader) {
      if (currentSection.headerLine !== null || currentSection.items.length > 0) {
        sections.push(currentSection);
      }
      const headerDate = extractDateFromLine(line);
      if (headerDate) activeDate = headerDate;

      currentSection = {
        headerLine: line,
        date: headerDate || activeDate,
        items: [],
      };
      continue;
    }

    // Check if line is a bullet item or continuation
    const isBullet = /^[-*]\s+/.test(line);
    const parsedTs = extractTimestampFromLine(line, activeDate);
    if (parsedTs?.date) {
      activeDate = parsedTs.date;
    }

    if (isBullet) {
      currentSection.items.push({
        lines: [line],
        date: parsedTs?.date || activeDate || currentSection.date,
        timestamp: parsedTs?.timestamp || null,
      });
    } else {
      // Continuation line or blank line
      if (currentSection.items.length > 0) {
        currentSection.items[currentSection.items.length - 1].lines.push(line);
      } else {
        // Line under header before any bullet
        currentSection.items.push({
          lines: [line],
          date: activeDate || currentSection.date,
          timestamp: null,
        });
      }
    }
  }

  if (currentSection.headerLine !== null || currentSection.items.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Rotates state file by archiving entries older than 24h.
 */
export function rotateState({ stateFile, archiveDir, now } = {}) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const resolvedStateFile =
    stateFile ||
    process.env.SONDER_STATE_FILE ||
    process.env.STATE_FILE ||
    path.join(repoRoot, "artifacts/orca/STATE.md");

  const resolvedArchiveDir =
    archiveDir ||
    process.env.SONDER_STATE_ARCHIVE_DIR ||
    process.env.STATE_ARCHIVE_DIR ||
    path.join(repoRoot, "artifacts/orca/state-archive");

  const stateDir = path.dirname(resolvedStateFile);
  fs.mkdirSync(stateDir, { recursive: true });

  const lockFile = `${resolvedStateFile}.lock`;
  const lockFd = fs.openSync(lockFile, "w");
  const flockRes = spawnSync("flock", ["-x", "3"], {
    stdio: [0, 1, 2, lockFd],
  });
  if (flockRes.status !== 0) {
    fs.closeSync(lockFd);
    throw new Error(`Failed to acquire lock on ${lockFile}: exit ${flockRes.status}`);
  }

  try {
    if (!fs.existsSync(resolvedStateFile)) {
      return { rotated: false, archivedFiles: [] };
    }

    const rawContent = fs.readFileSync(resolvedStateFile, "utf8");
    if (!rawContent.trim()) {
      return { rotated: false, archivedFiles: [] };
    }

    const hasTrailingNewline = rawContent.endsWith("\n");
    const allLines = rawContent.split("\n");
    if (hasTrailingNewline && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    const { pinned, rest } = splitPinnedSection(allLines);
    const nowDate = getNow(now);
    const cutoffMs = nowDate.getTime() - 24 * 60 * 60 * 1000;
    const cutoffDateStr = new Date(cutoffMs).toISOString().slice(0, 10);

    const sections = parseSections(rest);
    const olderLinesByDate = {};
    const recentLines = [];

    for (const section of sections) {
      const olderItems = [];
      const recentItems = [];

      for (const item of section.items) {
        let isOlder = false;
        if (item.timestamp) {
          isOlder = item.timestamp.getTime() < cutoffMs;
        } else if (item.date) {
          isOlder = item.date < cutoffDateStr;
        }

        if (isOlder && item.date) {
          olderItems.push(item);
        } else {
          recentItems.push(item);
        }
      }

      if (recentItems.length === 0 && section.headerLine !== null) {
        // Entire section is older
        const targetDate = section.date || olderItems[0]?.date || cutoffDateStr;
        if (!olderLinesByDate[targetDate]) olderLinesByDate[targetDate] = [];
        olderLinesByDate[targetDate].push(section.headerLine);
        for (const item of olderItems) {
          olderLinesByDate[targetDate].push(...item.lines);
        }
      } else {
        // Section has recent items, or header has no items
        if (section.headerLine !== null) {
          recentLines.push(section.headerLine);
        }
        for (const item of recentItems) {
          recentLines.push(...item.lines);
        }
        for (const item of olderItems) {
          const targetDate = item.date || section.date || cutoffDateStr;
          if (!olderLinesByDate[targetDate]) olderLinesByDate[targetDate] = [];
          olderLinesByDate[targetDate].push(...item.lines);
        }
      }
    }

    const dateKeys = Object.keys(olderLinesByDate).filter(
      (k) => olderLinesByDate[k] && olderLinesByDate[k].length > 0
    );

    if (dateKeys.length === 0) {
      return { rotated: false, archivedFiles: [] };
    }

    fs.mkdirSync(resolvedArchiveDir, { recursive: true });
    const archivedFiles = [];

    // Sort dates so archiving is deterministic
    dateKeys.sort();
    for (const date of dateKeys) {
      const linesToArchive = olderLinesByDate[date];
      const archivePath = path.join(resolvedArchiveDir, `${date}.md`);
      const contentToAppend = linesToArchive.join("\n") + "\n";

      if (fs.existsSync(archivePath)) {
        const existing = fs.readFileSync(archivePath, "utf8");
        const sep = existing.endsWith("\n") ? "" : "\n";
        const fd = fs.openSync(archivePath, "a");
        fs.writeFileSync(fd, sep + contentToAppend, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } else {
        const tmpArchive = path.join(resolvedArchiveDir, `${date}.tmp.${process.pid}`);
        const tmpFd = fs.openSync(tmpArchive, "w");
        fs.writeFileSync(tmpFd, contentToAppend, "utf8");
        fs.fsyncSync(tmpFd);
        fs.closeSync(tmpFd);
        fs.renameSync(tmpArchive, archivePath);
      }
      archivedFiles.push(archivePath);
    }

    if (process.env.TEST_HOOK_KILL_AFTER_ARCHIVE === "1") {
      process.kill(process.pid, "SIGKILL");
    }

    // Rewrite state file with pinned section + recent lines via temp+fsync+rename
    const finalLines = [...pinned, ...recentLines];
    let finalText = finalLines.join("\n");
    if (hasTrailingNewline || finalText.length > 0) {
      finalText += "\n";
    }

    const tmpStateFile = `${resolvedStateFile}.tmp.${process.pid}`;
    const tmpFd = fs.openSync(tmpStateFile, "w");
    fs.writeFileSync(tmpFd, finalText, "utf8");
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    fs.renameSync(tmpStateFile, resolvedStateFile);

    return { rotated: true, archivedFiles };
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch {
      // ignore
    }
  }
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  let stateFile = null;
  let archiveDir = null;
  let now = null;

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--state-file" && i + 1 < process.argv.length) {
      stateFile = process.argv[++i];
    } else if (process.argv[i] === "--archive-dir" && i + 1 < process.argv.length) {
      archiveDir = process.argv[++i];
    } else if (process.argv[i] === "--now" && i + 1 < process.argv.length) {
      now = process.argv[++i];
    }
  }

  const result = rotateState({ stateFile, archiveDir, now });
  if (result.rotated) {
    console.log(`Rotated state: archived to ${result.archivedFiles.join(", ")}`);
  }
}
