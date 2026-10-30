import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-preflight.sh");

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function makeRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-preflight-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "AGENTS.md"), "# agents\n");
  git(dir, "add", "AGENTS.md");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return dir;
}

// A fake df for the disk check: the test never runs the real one. It prints the header and the data line of a real
// `df -Pk <path>` (columns: filesystem, 1024-blocks, used, available, capacity, mount point) for the path it is
// asked about, from "path filesystem availableKiB mount" lines in a table file.
const GB = 1024 * 1024;
function makeFakeDf(table: Record<string, [string, number, string]>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-fakedf-")));
  const rows = Object.entries(table).map(([path, [fs, avail, mount]]) => `${path} ${fs} ${avail} ${mount}`);
  writeFileSync(join(dir, "table"), rows.join("\n") + "\n");
  const df = join(dir, "df");
  writeFileSync(
    df,
    `#!/usr/bin/env bash
echo "$@" >> "${dir}/calls"
echo "Filesystem                        1024-blocks     Used Available Capacity Mounted on"
awk -v p="$2" '$1 == p { print $2, 102626232, 71631380, $3, "74%", $4 }' "${dir}/table"
`,
  );
  chmodSync(df, 0o755);
  return { dir, df, calls: join(dir, "calls") };
}
const roomyDf = () => makeFakeDf({ "/": ["/dev/root", 100 * GB, "/"] });

function preflight(args: string[], cwd = tmpdir(), env: Record<string, string> = {}) {
  const fake = env.ORCA_PREFLIGHT_DF ? null : roomyDf();
  try {
    return spawnSync("bash", [script, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...(fake ? { ORCA_PREFLIGHT_DF: fake.df } : {}), ...env },
    });
  } finally {
    if (fake) rmSync(fake.dir, { recursive: true, force: true });
  }
}

test("passes when the doc exists on the base branch and the worktree is idle", () => {
  const repo = makeRepo();
  try {
    const result = preflight(["main", repo, "AGENTS.md"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fails with one line per missing doc", () => {
  const repo = makeRepo();
  try {
    const result = preflight(["main", repo, "AGENTS.md", "CLAUDE.md", "NOPE.md"]);
    assert.equal(result.status, 1);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /CLAUDE\.md/);
    assert.match(lines[1], /NOPE\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reports a process whose working directory is the worktree", async () => {
  const repo = makeRepo();
  const sub = join(repo, "sub");
  mkdirSync(sub);
  const child = spawn("sleep", ["30"], { cwd: sub, stdio: "ignore" });
  try {
    await new Promise((done) => child.once("spawn", done));
    const full = preflight(["main", repo, "AGENTS.md"]);
    assert.equal(full.status, 1);
    assert.match(full.stdout, new RegExp(`process ${child.pid} .*sleep 30`));

    const after = preflight(["--after-stop", repo]);
    assert.equal(after.status, 1);
    assert.match(after.stdout, new RegExp(`process ${child.pid} `));

    // --after-stop runs only the process check, so a missing doc is not reported.
    child.kill();
    await new Promise((done) => child.once("exit", done));
    const clean = preflight(["--after-stop", repo]);
    assert.equal(clean.status, 0, clean.stdout);
  } finally {
    child.kill();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ignores the caller and its parents even when they sit in the worktree", () => {
  const repo = makeRepo();
  try {
    const result = preflight(["main", repo, "AGENTS.md"], repo);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checks docs in the current repo when the worktree path does not exist yet", () => {
  const repo = makeRepo();
  try {
    const missingPath = join(repo, "not-created-yet");
    const ok = preflight(["main", missingPath, "AGENTS.md"], repo);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const missing = preflight(["main", missingPath, "NOPE.md"], repo);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /NOPE\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("exits 2 on bad usage", () => {
  assert.equal(preflight([]).status, 2);
  assert.equal(preflight(["main", "/tmp"]).status, 2);
  assert.equal(preflight(["--after-stop"]).status, 2);
});

test("fails with the free figure and the cleanup candidates when / is below the minimum", () => {
  const repo = makeRepo();
  const fake = makeFakeDf({ "/": ["/dev/root", 8.2 * GB, "/"] });
  try {
    const result = preflight(["main", repo, "AGENTS.md"], tmpdir(), { ORCA_PREFLIGHT_DF: fake.df });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /low disk: \/ has 8\.2 GB free, below ORCA_MIN_FREE_GB=15/);
    assert.match(result.stdout, /\/tmp\/sonder-browser-\*/);
    assert.match(result.stdout, /\/tmp\/sonder-local-check-\*/);
    assert.match(result.stdout, /docker builder prune/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("ORCA_MIN_FREE_GB moves the threshold", () => {
  const repo = makeRepo();
  const fake = makeFakeDf({ "/": ["/dev/root", 20 * GB, "/"] });
  try {
    const env = { ORCA_PREFLIGHT_DF: fake.df };
    assert.equal(preflight(["main", repo, "AGENTS.md"], tmpdir(), env).status, 0);
    const strict = preflight(["main", repo, "AGENTS.md"], tmpdir(), { ...env, ORCA_MIN_FREE_GB: "25" });
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /20\.0 GB free, below ORCA_MIN_FREE_GB=25/);
    const bad = preflight(["main", repo, "AGENTS.md"], tmpdir(), { ...env, ORCA_MIN_FREE_GB: "lots" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /ORCA_MIN_FREE_GB/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("checks the workspaces directory when it is on another filesystem, and only then", () => {
  const repo = makeRepo();
  const workspaces = realpathSync(mkdtempSync(join(tmpdir(), "sonder-ws-")));
  const nested = join(workspaces, "not-created-yet");
  try {
    const split = makeFakeDf({ "/": ["/dev/root", 50 * GB, "/"], [workspaces]: ["/dev/hdd", 3 * GB, "/mnt/hdd"] });
    const env = { ORCA_PREFLIGHT_DF: split.df, ORCA_SPAWN_WORKSPACES: nested };
    const low = preflight(["main", repo, "AGENTS.md"], tmpdir(), env);
    assert.equal(low.status, 1, low.stdout);
    assert.match(low.stdout, /low disk: \/mnt\/hdd has 3\.0 GB free/);
    assert.doesNotMatch(low.stdout, /low disk: \/ /);
    rmSync(split.dir, { recursive: true, force: true });

    // Same filesystem as /: one report, not two.
    const same = makeFakeDf({ "/": ["/dev/root", 5 * GB, "/"], [workspaces]: ["/dev/root", 5 * GB, "/"] });
    const once = preflight(["main", repo, "AGENTS.md"], tmpdir(), { ...env, ORCA_PREFLIGHT_DF: same.df });
    assert.equal(once.stdout.match(/low disk:/g)?.length, 1, once.stdout);
    rmSync(same.dir, { recursive: true, force: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(workspaces, { recursive: true, force: true });
  }
});

test("a df that prints nothing fails the preflight instead of passing it", () => {
  const repo = makeRepo();
  const fake = makeFakeDf({});
  try {
    const result = preflight(["main", repo, "AGENTS.md"], tmpdir(), { ORCA_PREFLIGHT_DF: fake.df });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /cannot read free space on \//);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("--after-stop does not look at the disk", () => {
  const repo = makeRepo();
  const fake = makeFakeDf({ "/": ["/dev/root", 1 * GB, "/"] });
  try {
    const result = preflight(["--after-stop", repo], tmpdir(), { ORCA_PREFLIGHT_DF: fake.df });
    assert.equal(result.status, 0, result.stdout);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
