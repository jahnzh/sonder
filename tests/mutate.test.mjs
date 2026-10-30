import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  countOccurrences,
  lastLines,
  runMutate,
} from "../scripts/mutate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "mutate.mjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sonder-mutate-"));
}

function writeSubject(dir, body = "const value = 1;\n") {
  const file = path.join(dir, "subject.js");
  fs.writeFileSync(file, body);
  return file;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
}

test("parseArgs requires file, search, replace and a test command after --", () => {
  assert.equal(parseArgs(["--file", "a"]).ok, false);
  const ok = parseArgs(["--file", "a", "--search", "x", "--replace", "y", "--", "node", "-e", "1"]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.options.testCmd, ["node", "-e", "1"]);
  assert.equal(ok.options.compile, "npx tsc --noEmit");
});

test("countOccurrences finds exactly-once vs zero vs many", () => {
  assert.equal(countOccurrences("abcabc", "ab"), 2);
  assert.equal(countOccurrences("abc", "ab"), 1);
  assert.equal(countOccurrences("abc", "z"), 0);
});

test("lastLines keeps only the trailing N lines", () => {
  const text = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
  const tail = lastLines(text, 15);
  assert.equal(tail.split("\n").length, 15);
  assert.match(tail, /^L5\n/);
  assert.match(tail, /L19$/);
});

test("exits 2 when --search does not occur exactly once", () => {
  const dir = tempDir();
  try {
    const file = writeSubject(dir, "aa\n");
    const missing = runCli([
      "--file", file, "--search", "zzz", "--replace", "y", "--compile", "none",
      "--", process.execPath, "-e", "process.exit(1)",
    ]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /occurs 0 time/);

    const many = runCli([
      "--file", file, "--search", "a", "--replace", "b", "--compile", "none",
      "--", process.execPath, "-e", "process.exit(1)",
    ]);
    assert.equal(many.status, 2);
    assert.match(many.stderr, /occurs 2 time/);
    assert.equal(fs.readFileSync(file, "utf8"), "aa\n", "file unchanged on search miss");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CAUGHT when the test fails after a compiling mutation; file is restored", () => {
  const dir = tempDir();
  try {
    const file = writeSubject(dir, "const value = 1;\n");
    const original = fs.readFileSync(file);
    const r = runCli([
      "--file", file,
      "--search", "value = 1",
      "--replace", "value = 2",
      "--compile", "none",
      "--", process.execPath, "-e", "process.exit(1)",
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /CAUGHT/);
    assert.deepEqual(fs.readFileSync(file), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SURVIVED when the test still passes after the mutation; file is restored", () => {
  const dir = tempDir();
  try {
    const file = writeSubject(dir, "const value = 1;\n");
    const original = fs.readFileSync(file);
    const r = runCli([
      "--file", file,
      "--search", "value = 1",
      "--replace", "value = 2",
      "--compile", "none",
      "--", process.execPath, "-e", "process.exit(0)",
    ]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /SURVIVED/);
    assert.deepEqual(fs.readFileSync(file), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exits 2 with compile output when the mutation does not compile", () => {
  const dir = tempDir();
  try {
    const file = writeSubject(dir, "const value = 1;\n");
    const original = fs.readFileSync(file);
    const compile = `node -e "console.error('tsc: type error'); process.exit(1)"`;
    const r = runCli([
      "--file", file,
      "--search", "value = 1",
      "--replace", "value = 2",
      "--compile", compile,
      "--", process.execPath, "-e", "process.exit(1)",
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /compile failed/);
    assert.match(r.stderr, /tsc: type error/);
    assert.ok(!/CAUGHT|SURVIVED/.test(r.stdout));
    assert.deepEqual(fs.readFileSync(file), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prints the test command's last 15 lines", () => {
  const dir = tempDir();
  try {
    const file = writeSubject(dir);
    const printer = `for (let i = 0; i < 20; i++) console.log('LINE_' + i); process.exit(1)`;
    const r = runCli([
      "--file", file, "--search", "value = 1", "--replace", "value = 9",
      "--compile", "none",
      "--", process.execPath, "-e", printer,
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /LINE_5/);
    assert.doesNotMatch(r.stdout, /LINE_4\n/);
    assert.match(r.stdout, /LINE_19/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("search and replace pass through argv without shell interpolation", () => {
  const dir = tempDir();
  try {
    const file = writeSubject(dir, "const x = '$HOME';\n");
    const original = fs.readFileSync(file);
    // If a shell expanded $HOME, the search would miss and exit 2.
    const r = runCli([
      "--file", file,
      "--search", "const x = '$HOME';",
      "--replace", "const x = 'nope';",
      "--compile", "none",
      "--", process.execPath, "-e", "process.exit(1)",
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /CAUGHT/);
    assert.deepEqual(fs.readFileSync(file), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restores the file byte-for-byte when killed mid-run with SIGTERM", async () => {
  const dir = tempDir();
  try {
    const body = Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x76, 0x20, 0x3d, 0x20, 0x31, 0x3b, 0x0a, 0x00, 0xff]);
    const file = path.join(dir, "binary-ish.js");
    fs.writeFileSync(file, body);
    // Test command sleeps long enough for us to signal the parent mutate process.
    const child = spawn(
      process.execPath,
      [
        script,
        "--file", file,
        "--search", "v = 1",
        "--replace", "v = 2",
        "--compile", "none",
        "--", process.execPath, "-e", "setTimeout(() => {}, 60000)",
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    // Wait until the mutation is applied (file no longer matches original).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const now = fs.readFileSync(file);
      if (!now.equals(body)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.notDeepEqual(fs.readFileSync(file), body, "mutation should be on disk before kill");
    child.kill("SIGTERM");
    const status = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    // Parent exits via handler (143) or by signal.
    assert.ok(status.code === 143 || status.signal === "SIGTERM" || status.code === null);
    assert.deepEqual(fs.readFileSync(file), body, "file restored after SIGTERM");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runMutate restore in finally even when spawn throws", async () => {
  const dir = tempDir();
  try {
    const file = writeSubject(dir, "alpha\n");
    const original = fs.readFileSync(file);
    const code = await runMutate(
      {
        file,
        search: "alpha",
        replace: "beta",
        compile: "none",
        testCmd: ["no-such-binary-mutate-test"],
      },
      {
        spawnAsync: () => {
          throw new Error("spawn boom");
        },
      },
    );
    assert.equal(code, 2);
    assert.deepEqual(fs.readFileSync(file), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
