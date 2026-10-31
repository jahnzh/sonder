import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UNIT = "orca-usage-collector.service";

function git(cwd, ...args) {
  const run = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

function stub(bin, name, body) {
  const file = join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

/** A throwaway main checkout holding only what the installer needs, with systemd stubbed out. */
function sandbox({ linger = "yes" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-usage-install-")));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  for (const path of [join(repo, "scripts"), join(repo, "deploy"), bin, home]) mkdirSync(path, { recursive: true });
  copyFileSync(join(repoRoot, "scripts", "install-usage-collector.sh"), join(repo, "scripts", "install-usage-collector.sh"));
  chmodSync(join(repo, "scripts", "install-usage-collector.sh"), 0o755);
  copyFileSync(join(repoRoot, "deploy", UNIT), join(repo, "deploy", UNIT));
  git(repo, "init", "-q");
  stub(bin, "systemctl", `echo "$@" >> "${dir}/systemctl.log"`);
  stub(bin, "loginctl", `echo ${linger}`);
  stub(bin, "codex", "exit 0");
  return { dir, repo, bin, home, installer: join(repo, "scripts", "install-usage-collector.sh"), unit: join(home, ".config", "systemd", "user", UNIT), log: join(dir, "systemctl.log") };
}

function install(box, args = [], from = box.installer) {
  return spawnSync("bash", [from, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: box.home, XDG_CONFIG_HOME: "", PATH: `${box.bin}:${process.env.PATH}` },
  });
}

const clean = (box) => rmSync(box.dir, { recursive: true, force: true });

test("it installs an enabled service that starts with the machine and runs this checkout", () => {
  const box = sandbox();
  try {
    const run = install(box);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.deepEqual(readFileSync(box.log, "utf8").trim().split("\n"), ["--user daemon-reload", `--user enable ${UNIT}`, `--user restart ${UNIT}`]);
    const unit = readFileSync(box.unit, "utf8");
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, new RegExp(`^ExecStart=${process.execPath.replaceAll(".", "\\.")} ${box.repo}/scripts/orca-usage\\.mjs run$`, "m"));
    assert.match(unit, new RegExp(`^WorkingDirectory=${box.repo}$`, "m"));
    assert.match(unit, new RegExp(`^Environment=PATH=${box.bin}:`, "m"), "the service must find codex");
    assert.doesNotMatch(unit, /@[A-Z]+@/);
  } finally {
    clean(box);
  }
});

test("the service PATH also reaches agy, so the Antigravity reader can start it", () => {
  const box = sandbox();
  try {
    const agyBin = join(box.dir, "agy-bin");
    mkdirSync(agyBin);
    stub(agyBin, "agy", "exit 0");
    const run = spawnSync("bash", [box.installer], {
      encoding: "utf8",
      env: { ...process.env, HOME: box.home, XDG_CONFIG_HOME: "", PATH: `${box.bin}:${agyBin}:${process.env.PATH}` },
    });
    assert.equal(run.status, 0, run.stderr);
    const unit = readFileSync(box.unit, "utf8");
    const path = unit.match(/^Environment=PATH=(.*)$/m)[1].split(":");
    assert.ok(path.includes(agyBin), `the service PATH must hold the agy directory: ${path.join(":")}`);
    assert.ok(path.includes(box.bin), "codex stays reachable");
  } finally {
    clean(box);
  }
});

test("a machine without agy still installs, because the other readers do not need it", () => {
  const box = sandbox();
  try {
    const run = install(box);
    assert.equal(run.status, 0, run.stderr);
  } finally {
    clean(box);
  }
});

test("--print shows the unit and changes nothing", () => {
  const box = sandbox();
  try {
    const run = install(box, ["--print"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^WantedBy=default\.target$/m);
    assert.equal(existsSync(box.unit), false);
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
    const run = install(box, [], join(worktree, "scripts", "install-usage-collector.sh"));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /is a worktree/);
    assert.equal(existsSync(box.unit), false);
    assert.equal(existsSync(box.log), false);
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

test("a machine without codex is refused rather than installing a service that cannot read", () => {
  const box = sandbox();
  try {
    rmSync(join(box.bin, "codex"));
    symlinkSync(process.execPath, join(box.bin, "node"));
    const run = spawnSync("bash", [box.installer], { encoding: "utf8", env: { ...process.env, HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin` } });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /codex is not on PATH/);
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
    assert.match(help.stdout, /--print/);
  } finally {
    clean(box);
  }
});
