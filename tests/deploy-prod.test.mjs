import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deployProd = join(repoRoot, "scripts", "deploy-prod.sh");

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, ...extra };
}

function git(cwd, args, env = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv(env) });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r;
}

/** Bare .git under prodRoot with checkout files at prodRoot (production layout). */
function prodFixture({ stubExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sonder-deploy-prod-"));
  const prodRoot = join(dir, "prod");
  const gitDir = join(prodRoot, ".git");
  const seed = join(dir, "seed");
  const stubLog = join(dir, "stub.log");

  mkdirSync(join(prodRoot, "scripts"), { recursive: true });
  git(dir, ["init", "--bare", "-q", gitDir]);

  mkdirSync(join(seed, "scripts"), { recursive: true });
  writeFileSync(
    join(seed, "scripts", "deploy.sh"),
    `#!/usr/bin/env bash
echo "HEAD=$(git rev-parse HEAD)" >> ${JSON.stringify(stubLog)}
echo "GIT_DIR=\${GIT_DIR-}" >> ${JSON.stringify(stubLog)}
echo "GIT_WORK_TREE=\${GIT_WORK_TREE-}" >> ${JSON.stringify(stubLog)}
echo "ARGS=$*" >> ${JSON.stringify(stubLog)}
exit ${stubExit}
`,
  );
  chmodSync(join(seed, "scripts", "deploy.sh"), 0o755);
  writeFileSync(join(seed, "marker.txt"), "v1\n");
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "."]);
  git(seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "v1"]);
  const sha1 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8", env: cleanEnv() }).stdout.trim();
  git(seed, ["remote", "add", "bare", gitDir]);
  git(seed, ["push", "-q", "bare", "main"]);

  writeFileSync(join(seed, "marker.txt"), "v2\n");
  git(seed, ["add", "marker.txt"]);
  git(seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "v2"]);
  const sha2 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8", env: cleanEnv() }).stdout.trim();
  git(seed, ["push", "-q", "bare", "main"]);

  git(dir, ["--git-dir", gitDir, "--work-tree", prodRoot, "checkout", "-q", "-f", "main"]);

  // Unless the caller passes its own marker flag (or bare), --no-marker is added: deploy requires one.
  const run = (sha, extraArgs = [], extraEnv = {}, { bare = false } = {}) => {
    if (!bare && !extraArgs.some((a) => ["--marker", "--marker-file", "--no-marker"].includes(a))) extraArgs = ["--no-marker", ...extraArgs];
    const env = cleanEnv({
      SONDER_PROD_ROOT: prodRoot,
      SONDER_PROD_DEPLOY_SCRIPT: join(prodRoot, "scripts", "deploy.sh"),
      ...extraEnv,
    });
    return spawnSync("bash", [deployProd, sha, ...extraArgs], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
  };

  const stubLines = () => readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean);

  const headSha = () =>
    spawnSync("git", ["--git-dir", gitDir, "--work-tree", prodRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: cleanEnv(),
    }).stdout.trim();

  const checkoutProd = (ref) => {
    git(dir, ["--git-dir", gitDir, "--work-tree", prodRoot, "checkout", "-q", "--detach", ref]);
  };

  return { dir, prodRoot, gitDir, sha1, sha2, run, stubLog, stubLines, headSha, checkoutProd };
}

test("checks out the commit, stub sees HEAD and GIT_* env, parent shell keeps no GIT_*", () => {
  const f = prodFixture();
  try {
    writeFileSync(f.stubLog, "");
    const r = f.run(f.sha2);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const lines = Object.fromEntries(f.stubLines().map((line) => line.split("=", 2)));
    assert.equal(lines.HEAD, f.sha2);
    assert.equal(lines.GIT_DIR, f.gitDir);
    assert.equal(lines.GIT_WORK_TREE, f.prodRoot);

    const shellCheck = spawnSync(
      "bash",
      [
        "-c",
        `unset GIT_DIR GIT_WORK_TREE
source /dev/null
bash ${JSON.stringify(deployProd)} ${JSON.stringify(f.sha1)} 2>/dev/null
if [ -n "\${GIT_DIR:-}" ] || [ -n "\${GIT_WORK_TREE:-}" ]; then exit 99; fi`,
      ],
      {
        encoding: "utf8",
        env: cleanEnv({
          SONDER_PROD_ROOT: f.prodRoot,
          SONDER_PROD_DEPLOY_SCRIPT: join(f.prodRoot, "scripts", "deploy.sh"),
        }),
      },
    );
    assert.notEqual(shellCheck.status, 99, shellCheck.stderr + shellCheck.stdout);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("passes deploy.sh exit code and forwards extra args when HEAD already matches", () => {
  const f = prodFixture({ stubExit: 7 });
  try {
    writeFileSync(f.stubLog, "");
    const r = f.run(f.sha2, ["--dry-run", "--skip-live-checks"]);
    assert.equal(r.status, 7);
    const argsLine = f.stubLines().find((l) => l.startsWith("ARGS="));
    assert.ok(argsLine?.includes("--dry-run"));
    assert.ok(argsLine?.includes("--skip-live-checks"));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("dry-run with a different commit leaves HEAD unchanged and does not run deploy.sh", () => {
  const f = prodFixture();
  try {
    f.checkoutProd(f.sha1);
    writeFileSync(f.stubLog, "");
    const before = f.headSha();
    const r = f.run(f.sha2, ["--dry-run"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(f.headSha(), before);
    assert.equal(f.stubLines().length, 0);
    assert.match(r.stderr, /would run: git checkout --detach/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("checkout refuses when an untracked file would be overwritten", () => {
  const f = prodFixture();
  const seed = join(f.dir, "seed");
  try {
    writeFileSync(join(seed, "collision.txt"), "tracked\n");
    git(seed, ["add", "collision.txt"]);
    git(seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "add collision"]);
    const sha3 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8", env: cleanEnv() }).stdout.trim();
    git(seed, ["push", "-q", "bare", "main"]);

    f.checkoutProd(f.sha1);
    writeFileSync(join(f.prodRoot, "collision.txt"), "untracked local\n");
    writeFileSync(f.stubLog, "");
    const before = f.headSha();
    const r = f.run(sha3);
    assert.notEqual(r.status, 0);
    assert.equal(f.headSha(), before);
    assert.equal(f.stubLines().length, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("refuses when tracked work-tree files are modified", () => {
  const f = prodFixture();
  try {
    writeFileSync(f.stubLog, "");
    writeFileSync(join(f.prodRoot, "marker.txt"), "dirty\n");
    const r = f.run(f.sha2);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /tracked files are modified/);
    assert.equal(f.stubLines().length, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rejects a deploy with no marker flag before touching the work tree", () => {
  const f = prodFixture();
  try {
    const head = f.headSha();
    const r = f.run(f.sha2, [], {}, { bare: true });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to deploy with no verification/);
    assert.equal(f.headSha(), head);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("forwards --marker-file to deploy.sh", () => {
  const f = prodFixture();
  try {
    const r = f.run(f.sha2, ["--marker-file", "/app/dist/index.html", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(f.stubLines().find((l) => l.startsWith("ARGS="))?.includes("--marker-file /app/dist/index.html"));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
