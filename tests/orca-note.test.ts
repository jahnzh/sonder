import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const noteScript = path.join(repoRoot, "scripts/orca/note.sh");
const wrapperScript = path.join(repoRoot, "artifacts/orca/note.sh");

function createTempWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonder-note-test-"));
  const stateFile = path.join(tmpDir, "artifacts/orca/STATE.md");
  const archiveDir = path.join(tmpDir, "artifacts/orca/state-archive");
  const decisionsFile = path.join(tmpDir, "artifacts/orca/DECISIONS.md");
  fs.mkdirSync(path.join(tmpDir, "artifacts/orca"), { recursive: true });

  const env: Record<string, string | undefined> = {
    ...process.env,
    SONDER_STATE_FILE: stateFile,
    SONDER_STATE_ARCHIVE_DIR: archiveDir,
    SONDER_DECISIONS_FILE: decisionsFile,
  };

  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, stateFile, archiveDir, decisionsFile, env, cleanup };
}

test("1. note.sh state records note with fake clock via SONDER_NOW", () => {
  const ws = createTempWorkspace();
  try {
    const fakeNow = "2026-11-07T10:15:30Z";
    execFileSync(noteScript, ["state", "Landed PR #100"], {
      env: { ...ws.env, SONDER_NOW: fakeNow },
    });

    const content = fs.readFileSync(ws.stateFile, "utf8");
    assert.match(
      content,
      /^- 2026-11-07T10:15:30Z Landed PR #100$/m,
      "STATE.md must contain note stamped with SONDER_NOW timestamp"
    );
  } finally {
    ws.cleanup();
  }
});

test("2. note.sh state records note with fake clock via DATE_CMD", () => {
  const ws = createTempWorkspace();
  try {
    const fakeCmd = "echo 2026-11-07T11:22:33Z";
    execFileSync(noteScript, ["state", "Worker finished"], {
      env: { ...ws.env, DATE_CMD: fakeCmd },
    });

    const content = fs.readFileSync(ws.stateFile, "utf8");
    assert.match(
      content,
      /^- 2026-11-07T11:22:33Z Worker finished$/m,
      "STATE.md must contain note stamped with DATE_CMD timestamp"
    );
  } finally {
    ws.cleanup();
  }
});

test("3. note.sh state records note with real UTC time", () => {
  const ws = createTempWorkspace();
  try {
    // Clear SONDER_NOW and DATE_CMD
    const env = { ...ws.env };
    delete env.SONDER_NOW;
    delete env.DATE_CMD;

    const before = Date.now();
    execFileSync(noteScript, ["state", "Real time verification"], { env });
    const after = Date.now();

    const content = fs.readFileSync(ws.stateFile, "utf8");
    const match = content.match(/^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) Real time verification$/m);
    assert.ok(match, "STATE.md must contain note stamped with ISO UTC timestamp");

    const parsedTime = Date.parse(match[1]);
    assert.ok(!isNaN(parsedTime), "Timestamp must be parseable");
    // Allow 10s window around execution time
    assert.ok(parsedTime >= before - 5000 && parsedTime <= after + 5000, "Timestamp must reflect real UTC time");
  } finally {
    ws.cleanup();
  }
});

test("4. note.sh decision records note in decisions file", () => {
  const ws = createTempWorkspace();
  try {
    const fakeNow = "2026-11-07T16:00:00Z";
    execFileSync(noteScript, ["decision", "C100 (coordinator) Use local cache"], {
      env: { ...ws.env, SONDER_NOW: fakeNow },
    });

    const content = fs.readFileSync(ws.decisionsFile, "utf8");
    assert.match(
      content,
      /^- 2026-11-07T16:00:00Z C100 \(coordinator\) Use local cache$/m,
      "DECISIONS.md must contain decision note stamped with UTC timestamp"
    );
  } finally {
    ws.cleanup();
  }
});

test("5. note.sh strips leading dash/bullet from input text", () => {
  const ws = createTempWorkspace();
  try {
    const fakeNow = "2026-11-07T12:00:00Z";
    execFileSync(noteScript, ["state", "- Note with leading dash"], {
      env: { ...ws.env, SONDER_NOW: fakeNow },
    });

    const content = fs.readFileSync(ws.stateFile, "utf8");
    assert.match(
      content,
      /^- 2026-11-07T12:00:00Z Note with leading dash$/m,
      "Must not produce double dashes when text starts with a dash"
    );
  } finally {
    ws.cleanup();
  }
});

test("6. Rotation keeps last 24 h and pinned section (<= 60 lines), moves older text to state-archive/YYYY-MM-DD.md", () => {
  const ws = createTempWorkspace();
  try {
    const initialContent = `# Current
- In-flight: #293 state notes
- Coordinator: term_a03d1717

## 2026-11-05
- 2026-11-05T09:00:00Z note from 2 days ago
- 2026-11-05T15:00:00Z second note 2 days ago

## 2026-11-06
- 2026-11-06T08:00:00Z note 28 hours ago
- 2026-11-06T18:00:00Z note 18 hours ago

## 2026-11-07
- 2026-11-07T06:00:00Z note 6 hours ago
`;
    fs.writeFileSync(ws.stateFile, initialContent, "utf8");

    // Reference time: 2026-11-07T12:00:00Z. Cutoff is 2026-11-06T12:00:00Z.
    execFileSync(noteScript, ["rotate"], {
      env: { ...ws.env, SONDER_NOW: "2026-11-07T12:00:00Z" },
    });

    // Check archive files
    const archive05 = path.join(ws.archiveDir, "2026-11-05.md");
    const archive06 = path.join(ws.archiveDir, "2026-11-06.md");

    assert.ok(fs.existsSync(archive05), "2026-11-05.md archive must exist");
    assert.ok(fs.existsSync(archive06), "2026-11-06.md archive must exist");

    const content05 = fs.readFileSync(archive05, "utf8");
    const content06 = fs.readFileSync(archive06, "utf8");
    const currentState = fs.readFileSync(ws.stateFile, "utf8");

    // 2026-11-05: entire section was older
    assert.match(content05, /## 2026-11-05/);
    assert.match(content05, /note from 2 days ago/);
    assert.match(content05, /second note 2 days ago/);

    // 2026-11-06: note at 08:00 was older (>24h)
    assert.match(content06, /note 28 hours ago/);
    assert.doesNotMatch(content06, /note 18 hours ago/);

    // Current STATE.md: retains pinned # Current, recent 18h note, and 2026-11-07 note
    assert.match(currentState, /# Current/);
    assert.match(currentState, /In-flight: #293 state notes/);
    assert.match(currentState, /note 18 hours ago/);
    assert.match(currentState, /## 2026-11-07/);
    assert.match(currentState, /note 6 hours ago/);
    assert.doesNotMatch(currentState, /note from 2 days ago/);
    assert.doesNotMatch(currentState, /note 28 hours ago/);

    // Verify: archive plus current equals the old file (no text dropped)
    const oldLines = initialContent.split("\n").filter((l) => l.trim().length > 0);
    const combinedLines = (content05 + "\n" + content06 + "\n" + currentState)
      .split("\n")
      .filter((l) => l.trim().length > 0);

    for (const line of oldLines) {
      assert.ok(
        combinedLines.includes(line),
        `Line must be preserved in archive or current: "${line}"`
      );
    }
    assert.equal(combinedLines.length, oldLines.length, "No lines duplicated or lost");
  } finally {
    ws.cleanup();
  }
});

test("7. Rotation is idempotent", () => {
  const ws = createTempWorkspace();
  try {
    const initialContent = `# Current
- Pinned item

## 2026-11-05
- 2026-11-05T10:00:00Z older note

## 2026-11-07
- 2026-11-07T10:00:00Z recent note
`;
    fs.writeFileSync(ws.stateFile, initialContent, "utf8");

    const nowEnv = { ...ws.env, SONDER_NOW: "2026-11-07T12:00:00Z" };

    // First rotation
    execFileSync(noteScript, ["rotate"], { env: nowEnv });
    const stateAfterRun1 = fs.readFileSync(ws.stateFile, "utf8");
    const archive05Run1 = fs.readFileSync(path.join(ws.archiveDir, "2026-11-05.md"), "utf8");

    // Second rotation (same clock)
    execFileSync(noteScript, ["rotate"], { env: nowEnv });
    const stateAfterRun2 = fs.readFileSync(ws.stateFile, "utf8");
    const archive05Run2 = fs.readFileSync(path.join(ws.archiveDir, "2026-11-05.md"), "utf8");

    assert.equal(stateAfterRun2, stateAfterRun1, "STATE.md must not change on subsequent rotation");
    assert.equal(archive05Run2, archive05Run1, "Archive must not change on subsequent rotation");

    // Third rotation
    execFileSync(noteScript, ["rotate"], { env: nowEnv });
    assert.equal(fs.readFileSync(ws.stateFile, "utf8"), stateAfterRun1, "STATE.md remains identical on 3rd run");
  } finally {
    ws.cleanup();
  }
});

test("8. note.sh state automatically triggers rotation", () => {
  const ws = createTempWorkspace();
  try {
    const initialContent = `# Current
- Active

## 2026-11-05
- 2026-11-05T10:00:00Z old note
`;
    fs.writeFileSync(ws.stateFile, initialContent, "utf8");

    // Appending a note at 2026-11-07T12:00:00Z should append and rotate out 2026-11-05
    execFileSync(noteScript, ["state", "New note today"], {
      env: { ...ws.env, SONDER_NOW: "2026-11-07T12:00:00Z" },
    });

    const currentState = fs.readFileSync(ws.stateFile, "utf8");
    assert.match(currentState, /# Current/);
    assert.match(currentState, /^- 2026-11-07T12:00:00Z New note today$/m);
    assert.doesNotMatch(currentState, /old note/);

    const archiveFile = path.join(ws.archiveDir, "2026-11-05.md");
    assert.ok(fs.existsSync(archiveFile), "Older note must have been archived automatically");
    assert.match(fs.readFileSync(archiveFile, "utf8"), /old note/);
  } finally {
    ws.cleanup();
  }
});

test("9. Thin wrapper artifacts/orca/note.sh delegates to scripts/orca/note.sh", () => {
  const ws = createTempWorkspace();
  try {
    assert.ok(fs.existsSync(wrapperScript), "artifacts/orca/note.sh must exist");
    const fakeNow = "2026-11-07T18:30:00Z";
    execFileSync(wrapperScript, ["state", "Called via wrapper"], {
      env: { ...ws.env, SONDER_NOW: fakeNow },
    });

    const content = fs.readFileSync(ws.stateFile, "utf8");
    assert.match(content, /^- 2026-11-07T18:30:00Z Called via wrapper$/m);
  } finally {
    ws.cleanup();
  }
});

test("10. Coordinator documentation in docs/agents/worker-spec.md points at note.sh", () => {
  const doc = fs.readFileSync(path.join(repoRoot, "docs/agents/worker-spec.md"), "utf8");
  assert.match(doc, /scripts\/orca\/note\.sh/, "worker-spec.md must point at scripts/orca/note.sh");
  assert.match(doc, /note\.sh state/, "worker-spec.md must describe note.sh state");
  assert.match(doc, /note\.sh decision/, "worker-spec.md must describe note.sh decision");
  assert.match(doc, /state-archive\/YYYY-MM-DD\.md/, "worker-spec.md must mention state-archive/YYYY-MM-DD.md");
  assert.match(doc, /idempotent/, "worker-spec.md must mention idempotent rotation");
});
