import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UNIT = "sonder-torrent-watch.service";

function git(cwd, ...args) {
  const run = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

function stub(bin, name, body) {
  const file = join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

/** A throwaway main checkout holding only what the installer needs, with systemd and docker stubbed out. */
function sandbox({ linger = "yes" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-torrent-watch-install-")));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  for (const path of [join(repo, "scripts"), join(repo, "deploy"), bin, home]) mkdirSync(path, { recursive: true });
  copyFileSync(join(repoRoot, "scripts", "install-torrent-watch.sh"), join(repo, "scripts", "install-torrent-watch.sh"));
  chmodSync(join(repo, "scripts", "install-torrent-watch.sh"), 0o755);
  copyFileSync(join(repoRoot, "deploy", UNIT), join(repo, "deploy", UNIT));
  git(repo, "init", "-q");
  stub(bin, "systemctl", `echo "$@" >> "${dir}/systemctl.log"`);
  stub(bin, "loginctl", `echo ${linger}`);
  // Never run: the installer only records where docker is.
  stub(bin, "docker", `echo "docker must not run during install" >&2; exit 99`);
  return { dir, repo, bin, home, installer: join(repo, "scripts", "install-torrent-watch.sh"), unit: join(home, ".config", "systemd", "user", UNIT), log: join(dir, "systemctl.log") };
}

function install(box, args = [], from = box.installer, path = `${box.bin}:${process.env.PATH}`) {
  return spawnSync("bash", [from, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: box.home, XDG_CONFIG_HOME: "", PATH: path },
  });
}

const clean = (box) => rmSync(box.dir, { recursive: true, force: true });

test("it installs an enabled service that starts with the machine and runs the watcher from this checkout", () => {
  const box = sandbox();
  try {
    const run = install(box);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.deepEqual(readFileSync(box.log, "utf8").trim().split("\n"), ["--user daemon-reload", `--user enable ${UNIT}`, `--user restart ${UNIT}`]);
    const unit = readFileSync(box.unit, "utf8");
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, new RegExp(`^ExecStart=${process.execPath.replaceAll(".", "\\.")} ${box.repo}/scripts/torrent-vpn-watch\\.mjs$`, "m"));
    assert.match(unit, new RegExp(`^WorkingDirectory=${box.repo}$`, "m"));
    assert.match(unit, new RegExp(`^Environment=PATH=${box.bin}:`, "m"), "the service must find docker");
    assert.doesNotMatch(unit, /@[A-Z]+@/);
  } finally {
    clean(box);
  }
});

test("--print shows the unit and changes nothing", () => {
  const box = sandbox();
  try {
    const run = install(box, ["--print"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^ExecStart=.*torrent-vpn-watch\.mjs$/m);
    assert.equal(existsSync(box.unit), false);
    assert.equal(existsSync(box.log), false);
  } finally {
    clean(box);
  }
});

test("--remove stops, disables and deletes the unit, and is harmless when it is not installed", () => {
  const box = sandbox();
  try {
    assert.equal(install(box).status, 0);
    rmSync(box.log);
    const run = install(box, ["--remove"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /removed/);
    assert.deepEqual(readFileSync(box.log, "utf8").trim().split("\n"), [`--user disable --now ${UNIT}`, "--user daemon-reload"]);
    assert.equal(existsSync(box.unit), false);
    rmSync(box.log);
    const again = install(box, ["--remove"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /not installed/);
    assert.equal(existsSync(box.log), false);
  } finally {
    clean(box);
  }
});

test("a worktree is refused, because the service would run a checkout that gets removed", () => {
  const box = sandbox();
  try {
    git(box.repo, "add", ".");
    git(box.repo, "commit", "-qm", "base");
    const worktree = join(box.dir, "worktree");
    git(box.repo, "worktree", "add", "-q", worktree);
    const run = install(box, [], join(worktree, "scripts", "install-torrent-watch.sh"));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /is a worktree/);
    assert.equal(existsSync(box.unit), false);
  } finally {
    clean(box);
  }
});

test("without lingering it warns that the service will not start at boot", () => {
  const box = sandbox({ linger: "no" });
  try {
    const run = install(box);
    assert.equal(run.status, 0);
    assert.match(run.stderr, /enable-linger/);
  } finally {
    clean(box);
  }
});

test("a machine without docker is refused rather than installing a watcher that cannot see the containers", () => {
  const box = sandbox();
  try {
    // A PATH holding only the tools the installer uses, so a real docker elsewhere on the machine is not found.
    const tools = join(box.dir, "tools");
    mkdirSync(tools);
    for (const name of ["bash", "git", "sed", "dirname", "mkdir", "id"]) {
      const found = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      assert.ok(found, `${name} must exist for this test`);
      symlinkSync(found, join(tools, name));
    }
    symlinkSync(process.execPath, join(tools, "node"));
    const run = install(box, [], box.installer, tools);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /docker is not on PATH/);
    assert.equal(existsSync(box.unit), false);
  } finally {
    clean(box);
  }
});

test("bad options exit 2 and help exits 0", () => {
  const box = sandbox();
  try {
    assert.equal(install(box, ["--nope"]).status, 2);
    const help = install(box, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--remove/);
  } finally {
    clean(box);
  }
});
