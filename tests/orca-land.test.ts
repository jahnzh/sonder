import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "orca-land.sh");

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function stub(bin: string, name: string, body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Temp main checkout linked to a bare origin, plus one worktree under workspaces/.
 * Fake `gh` on PATH returns OPEN/MERGEABLE by default (override via STUB_GH_*).
 */
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-land-")));
  const bin = join(dir, "bin");
  const workspaces = join(dir, "ws");
  const bare = join(dir, "origin.git");
  const main = join(dir, "main");
  mkdirSync(bin);
  mkdirSync(workspaces);

  spawnSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
  git(dir, ["clone", bare, main]);
  writeFileSync(join(main, "README.md"), "main\n");
  git(main, ["add", "README.md"]);
  git(main, ["commit", "-m", "init"]);
  git(main, ["push", "-u", "origin", "main"]);

  // Feature branch + worktree.
  git(main, ["checkout", "-b", "jahnzh/feat-99-land"]);
  writeFileSync(join(main, "feature.txt"), "feat\n");
  git(main, ["add", "feature.txt"]);
  git(main, ["commit", "-m", "feat"]);
  git(main, ["push", "-u", "origin", "jahnzh/feat-99-land"]);
  // Alias branch with the same tip (should be deleted on land).
  git(main, ["branch", "jahnzh/issue-99-alias"]);
  // Leave main on main before adding the feature worktree (a branch can only be checked out once).
  git(main, ["checkout", "main"]);
  // Unrelated jahnzh branch with a different tip — must survive.
  git(main, ["branch", "jahnzh/other-tip"]);

  const wt = join(workspaces, "land-wt");
  git(main, ["worktree", "add", wt, "jahnzh/feat-99-land"]);

  // Open a PR-like head on origin/main's parent so merge --ff-only can advance main
  // after gh merge fast-forwards origin/main in the stub.
  stub(
    bin,
    "gh",
    `
echo "$*" >>"$STUB_GH_LOG"
cmd=$1; shift
case "$cmd" in
  pr)
    sub=$1; shift
    case "$sub" in
      view)
        state=\${STUB_GH_STATE:-OPEN}
        mergeable=\${STUB_GH_MERGEABLE:-MERGEABLE}
        echo "{\\"state\\":\\"$state\\",\\"mergeable\\":\\"$mergeable\\",\\"baseRefName\\":\\"main\\",\\"headRefName\\":\\"jahnzh/feat-99-land\\",\\"url\\":\\"https://example/pr/99\\"}"
        ;;
      merge)
        # Simulate GitHub merging the PR into main on the bare remote.
        git --git-dir="$STUB_BARE" update-ref refs/heads/main refs/heads/jahnzh/feat-99-land
        echo merged "$@"
        ;;
      *)
        echo "unexpected gh pr $sub" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unexpected gh $cmd" >&2
    exit 1
    ;;
esac
`,
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ORCA_SPAWN_WORKSPACES: workspaces,
    ORCA_LAND_MAIN: main,
    STUB_GH_LOG: join(dir, "gh.log"),
    STUB_BARE: bare,
  };

  const run = (args: string[]) =>
    spawnSync("bash", [script, ...args], { encoding: "utf8", env, cwd: repoRoot });

  return { dir, main, wt, bare, workspaces, run, ghLog: join(dir, "gh.log") };
}

test("usage exit 2 without --pr or --worktree", () => {
  const t = setup();
  try {
    assert.equal(t.run([]).status, 2);
    assert.equal(t.run(["--pr", "99"]).status, 2);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses when the PR is not OPEN and MERGEABLE", () => {
  const t = setup();
  try {
    const closed = spawnSync("bash", [script, "--pr", "99", "--worktree", "land-wt"], {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${join(t.dir, "bin")}:${process.env.PATH}`,
        ORCA_SPAWN_WORKSPACES: t.workspaces,
        ORCA_LAND_MAIN: t.main,
        STUB_GH_LOG: t.ghLog,
        STUB_BARE: t.bare,
        STUB_GH_STATE: "CLOSED",
        STUB_GH_MERGEABLE: "MERGEABLE",
      },
    });
    assert.equal(closed.status, 1);
    assert.match(closed.stderr, /refusing:.*state=CLOSED/);

    const conflict = spawnSync("bash", [script, "--pr", "99", "--worktree", "land-wt"], {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${join(t.dir, "bin")}:${process.env.PATH}`,
        ORCA_SPAWN_WORKSPACES: t.workspaces,
        ORCA_LAND_MAIN: t.main,
        STUB_GH_LOG: t.ghLog,
        STUB_BARE: t.bare,
        STUB_GH_STATE: "OPEN",
        STUB_GH_MERGEABLE: "CONFLICTING",
      },
    });
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /mergeable=CONFLICTING/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses a dirty worktree unless the only dirt is untracked REPORT.md", () => {
  const t = setup();
  try {
    writeFileSync(join(t.wt, "extra.txt"), "nope\n");
    const dirty = t.run(["--pr", "99", "--worktree", "land-wt"]);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /uncommitted changes/);

    rmSync(join(t.wt, "extra.txt"));
    writeFileSync(join(t.wt, "REPORT.md"), "notes\n");
    // Dry-run should get past the dirt check.
    const ok = t.run(["--pr", "99", "--worktree", "land-wt", "--dry-run"]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /dry-run: gh pr merge 99 --merge/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("--dry-run prints every step without merging or removing the worktree", () => {
  const t = setup();
  try {
    const before = spawnSync("git", ["worktree", "list"], { cwd: t.main, encoding: "utf8" });
    const r = t.run(["--pr", "99", "--worktree", "land-wt", "--dry-run"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /check PR #99 is OPEN and MERGEABLE/);
    assert.match(r.stdout, /dry-run: gh pr merge 99 --merge/);
    assert.match(r.stdout, /dry-run: \(stash -u if dirty\); git fetch; git merge --ff-only origin\/main/);
    assert.match(r.stdout, /dry-run: git worktree remove --force/);
    assert.match(r.stdout, /dry-run: git branch -D jahnzh\/feat-99-land/);
    assert.match(r.stdout, /dry-run: git branch -D jahnzh\/issue-99-alias/);
    assert.doesNotMatch(r.stdout, /jahnzh\/other-tip/);
    assert.ok(existsSync(t.wt));
    const after = spawnSync("git", ["worktree", "list"], { cwd: t.main, encoding: "utf8" });
    assert.equal(after.stdout, before.stdout);
    const ghLog = existsSync(t.ghLog) ? readFileSync(t.ghLog, "utf8") : "";
    assert.match(ghLog, /pr view 99/);
    assert.doesNotMatch(ghLog, /pr merge/, "dry-run must not merge");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("lands: merges via gh, ff-only updates main, removes worktree and same-tip jahnzh branches", () => {
  const t = setup();
  try {
    const tip = spawnSync("git", ["rev-parse", "jahnzh/feat-99-land"], {
      cwd: t.main,
      encoding: "utf8",
    }).stdout.trim();

    const r = t.run(["--pr", "99", "--worktree", "land-wt"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(t.ghLog, "utf8"), /pr merge 99 --merge/);
    assert.equal(existsSync(t.wt), false);

    const branches = spawnSync("git", ["branch", "--list"], { cwd: t.main, encoding: "utf8" }).stdout;
    assert.doesNotMatch(branches, /feat-99-land/);
    assert.doesNotMatch(branches, /issue-99-alias/);
    assert.match(branches, /other-tip/, "different-tip jahnzh branch kept");

    const mainTip = spawnSync("git", ["rev-parse", "HEAD"], { cwd: t.main, encoding: "utf8" }).stdout.trim();
    assert.equal(mainTip, tip, "main fast-forwarded to the landed tip");
    assert.ok(existsSync(join(t.main, "feature.txt")));
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("stashes a dirty main checkout around fetch/merge and restores it", () => {
  const t = setup();
  try {
    writeFileSync(join(t.main, "wip.txt"), "local work\n");
    const r = t.run(["--pr", "99", "--worktree", "land-wt"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /stashing dirty main/);
    assert.match(r.stdout, /restoring stash/);
    assert.equal(readFileSync(join(t.main, "wip.txt"), "utf8"), "local work\n");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("never invokes gh pr edit", () => {
  const t = setup();
  try {
    t.run(["--pr", "99", "--worktree", "land-wt"]);
    const log = readFileSync(t.ghLog, "utf8");
    assert.doesNotMatch(log, /pr edit/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
