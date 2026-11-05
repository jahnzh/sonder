import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function isolatedGitEnv(home: string, inheritedEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => !key.startsWith("GIT_")));
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
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
function setup(inheritedEnv: NodeJS.ProcessEnv = process.env) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-land-")));
  const bin = join(dir, "bin");
  const workspaces = join(dir, "ws");
  const bare = join(dir, "origin.git");
  const main = join(dir, "main");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(workspaces);
  mkdirSync(home);
  const gitEnv = isolatedGitEnv(home, inheritedEnv);
  const fixtureGit = (cwd: string, args: string[]) => git(cwd, args, gitEnv);

  fixtureGit(dir, ["init", "--bare", "-b", "main", bare]);
  fixtureGit(dir, ["clone", bare, main]);
  writeFileSync(join(main, "README.md"), "main\n");
  fixtureGit(main, ["add", "README.md"]);
  fixtureGit(main, ["commit", "-m", "init"]);
  fixtureGit(main, ["push", bare, "main"]);

  // Feature branch + worktree.
  fixtureGit(main, ["checkout", "-b", "jahnzh/feat-99-land"]);
  writeFileSync(join(main, "feature.txt"), "feat\n");
  fixtureGit(main, ["add", "feature.txt"]);
  fixtureGit(main, ["commit", "-m", "feat"]);
  fixtureGit(main, ["push", bare, "jahnzh/feat-99-land"]);
  // Alias branch with the same tip (should be deleted on land).
  fixtureGit(main, ["branch", "jahnzh/issue-99-alias"]);
  // Leave main on main before adding the feature worktree (a branch can only be checked out once).
  fixtureGit(main, ["checkout", "main"]);
  // Unrelated jahnzh branch with a different tip — must survive.
  fixtureGit(main, ["branch", "jahnzh/other-tip"]);

  const wt = join(workspaces, "land-wt");
  fixtureGit(main, ["worktree", "add", wt, "jahnzh/feat-99-land"]);

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
    ...gitEnv,
    PATH: `${bin}:${inheritedEnv.PATH}`,
    ORCA_SPAWN_WORKSPACES: workspaces,
    ORCA_LAND_MAIN: main,
    STUB_GH_LOG: join(dir, "gh.log"),
    STUB_BARE: bare,
  };

  const run = (args: string[]) =>
    spawnSync("bash", [script, ...args], { encoding: "utf8", env, cwd: repoRoot });

  return { dir, main, wt, bare, workspaces, run, env, ghLog: join(dir, "gh.log") };
}

test("push fixture ignores a hostile repository and can only push to its temporary bare remote", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "sonder-land-outside-")));
  let fixture: ReturnType<typeof setup> | undefined;
  try {
    const outsideEnv = isolatedGitEnv(outside);
    const victim = join(outside, "pushing-repo");
    const otherRemote = join(outside, "other.git");
    const hostileHome = join(outside, "home");
    mkdirSync(victim);
    mkdirSync(hostileHome);
    git(outside, ["init", "--bare", "-b", "main", otherRemote], outsideEnv);
    git(victim, ["init"], outsideEnv);
    writeFileSync(join(victim, "original.txt"), "original\n");
    git(victim, ["add", "original.txt"], outsideEnv);
    git(victim, ["commit", "-m", "original"], outsideEnv);
    git(victim, ["remote", "add", "origin", otherRemote], outsideEnv);
    const before = {
      head: git(victim, ["rev-parse", "HEAD"], outsideEnv).stdout,
      config: readFileSync(join(victim, ".git", "config")),
      index: readFileSync(join(victim, ".git", "index")),
    };
    writeFileSync(join(hostileHome, ".gitconfig"), `[remote "origin"]\n\tpushurl = ${otherRemote}\n`);

    fixture = setup({
      ...process.env,
      HOME: hostileHome,
      XDG_CONFIG_HOME: hostileHome,
      GIT_DIR: join(victim, ".git"),
      GIT_WORK_TREE: victim,
      GIT_INDEX_FILE: join(victim, ".git", "index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "remote.origin.pushurl",
      GIT_CONFIG_VALUE_0: otherRemote,
    });
    const refs = git(fixture.bare, ["show-ref"], fixture.env).stdout;
    assert.match(refs, /refs\/heads\/main/);
    assert.match(refs, /refs\/heads\/jahnzh\/feat-99-land/);
    const landed = fixture.run(["--pr", "99", "--worktree", "land-wt"]);
    assert.equal(landed.status, 0, landed.stdout + landed.stderr);
    assert.deepEqual(readdirSync(join(otherRemote, "refs", "heads")), []);
    assert.equal(git(victim, ["rev-parse", "HEAD"], outsideEnv).stdout, before.head);
    assert.deepEqual(readFileSync(join(victim, ".git", "config")), before.config);
    assert.deepEqual(readFileSync(join(victim, ".git", "index")), before.index);
    assert.equal(readFileSync(join(victim, "original.txt"), "utf8"), "original\n");
  } finally {
    if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

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
        ...t.env,
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
        ...t.env,
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
    const before = git(t.main, ["worktree", "list"], t.env);
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
    const after = git(t.main, ["worktree", "list"], t.env);
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
    const tip = git(t.main, ["rev-parse", "jahnzh/feat-99-land"], t.env).stdout.trim();

    const r = t.run(["--pr", "99", "--worktree", "land-wt"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(t.ghLog, "utf8"), /pr merge 99 --merge/);
    assert.equal(existsSync(t.wt), false);

    const branches = git(t.main, ["branch", "--list"], t.env).stdout;
    assert.doesNotMatch(branches, /feat-99-land/);
    assert.doesNotMatch(branches, /issue-99-alias/);
    assert.match(branches, /other-tip/, "different-tip jahnzh branch kept");

    const mainTip = git(t.main, ["rev-parse", "HEAD"], t.env).stdout.trim();
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
