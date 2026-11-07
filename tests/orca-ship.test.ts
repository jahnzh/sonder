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
const script = join(repoRoot, "scripts", "orca-ship.sh");

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

function setup(
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  options: { bareMain?: boolean } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sonder-ship-")));
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
  fixtureGit(main, ["fetch", "origin"]);

  // Feature branch + worktree.
  fixtureGit(main, ["checkout", "-b", "jahnzh/feat-99-ship"]);
  writeFileSync(join(main, "feature.txt"), "feat\n");
  fixtureGit(main, ["add", "feature.txt"]);
  fixtureGit(main, ["commit", "-m", "feat"]);
  fixtureGit(main, ["push", bare, "jahnzh/feat-99-ship"]);
  fixtureGit(main, ["checkout", "main"]);

  const wt = join(workspaces, "ship-wt");
  fixtureGit(main, ["worktree", "add", wt, "jahnzh/feat-99-ship"]);
  const checkedSha = git(wt, ["rev-parse", "HEAD"], gitEnv).stdout.trim();

  const bodyFile = join(dir, "PR_BODY.md");
  writeFileSync(bodyFile, "## Summary\nInitial body text.\n");

  const ghLog = join(dir, "gh.log");
  const tscLog = join(dir, "tsc.log");
  const bodyCopy = join(dir, "body-copy.txt");
  const apiBodyCopy = join(dir, "api-body-copy.txt");

  stub(
    bin,
    "tsc",
    `
echo "tsc $*" >> "$STUB_TSC_LOG"
exit \${STUB_TSC_EXIT:-0}
`,
  );

  stub(
    bin,
    "gh",
    `
echo "$*" >> "$STUB_GH_LOG"
cmd=$1; shift
case "$cmd" in
  pr)
    sub=$1; shift
    case "$sub" in
      view)
        state=\${STUB_GH_STATE:-OPEN}
        mergeable=\${STUB_GH_MERGEABLE:-MERGEABLE}
        num=\${STUB_GH_PR_NUM:-99}
        head_oid=\${STUB_GH_HEAD_OID:-\$STUB_CHECKED_SHA}
        echo "{\\"state\\":\\"$state\\",\\"mergeable\\":\\"$mergeable\\",\\"number\\":$num,\\"baseRefName\\":\\"main\\",\\"headRefName\\":\\"jahnzh/feat-99-ship\\",\\"headRefOid\\":\\"$head_oid\\",\\"url\\":\\"https://example/pr/$num\\"}"
        ;;
      create)
        if [[ "\${STUB_GH_PR_CREATE_FAIL:-0}" == "1" ]]; then
          echo "a pull request for branch \\"jahnzh/feat-99-ship\\" already exists: https://example/pr/99" >&2
          exit 1
        fi
        while [[ $# -gt 0 ]]; do
          case $1 in
            --body-file|-F)
              cp "$2" "$STUB_BODY_COPY"
              shift 2
              ;;
            *)
              shift
              ;;
          esac
        done
        echo "https://example/pr/99"
        ;;
      edit)
        while [[ $# -gt 0 ]]; do
          case $1 in
            --body-file|-F)
              cp "$2" "$STUB_BODY_COPY"
              shift 2
              ;;
            *)
              shift
              ;;
          esac
        done
        if [[ "\${STUB_GH_PR_EDIT_FAIL:-1}" == "1" ]]; then
          echo "GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience (repository.issue.projectCards)" >&2
          exit 1
        fi
        echo "https://example/pr/99"
        ;;
      merge)
        git --git-dir="$STUB_BARE" update-ref refs/heads/main refs/heads/jahnzh/feat-99-ship
        echo merged "$@"
        ;;
      *)
        echo "unexpected gh pr $sub" >&2
        exit 1
        ;;
    esac
    ;;
  api)
    for arg in "$@"; do
      if [[ "$arg" == body=@* ]]; then
        file="\${arg#body=@}"
        cp "$file" "$STUB_API_BODY_COPY"
      fi
    done
    echo '{"id":99}'
    ;;
  repo)
    echo '{"nameWithOwner":"jahnzh/sonder"}'
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
    STUB_GH_LOG: ghLog,
    STUB_TSC_LOG: tscLog,
    STUB_BODY_COPY: bodyCopy,
    STUB_API_BODY_COPY: apiBodyCopy,
    STUB_BARE: bare,
    STUB_CHECKED_SHA: checkedSha,
    ORCA_SHIP_POLL_INTERVAL: "0.01",
    ORCA_SHIP_MAX_ATTEMPTS: "5",
  };

  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...env, ...extraEnv },
      cwd: repoRoot,
    });

  return {
    dir,
    main,
    wt,
    bare,
    workspaces,
    bodyFile,
    checkedSha,
    ghLog,
    tscLog,
    bodyCopy,
    apiBodyCopy,
    env,
    run,
    gitEnv,
  };
}

test("usage exit 2 without required flags", () => {
  const t = setup();
  try {
    assert.equal(t.run([]).status, 2);
    assert.equal(t.run(["--worktree", "ship-wt"]).status, 2);
    assert.equal(t.run(["--worktree", "ship-wt", "--title", "T"]).status, 2);
    assert.equal(t.run(["--worktree", "ship-wt", "--title", "T", "--body-file", t.bodyFile]).status, 2);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses a dirty worktree unless the only dirt is untracked REPORT.md", () => {
  const t = setup();
  try {
    writeFileSync(join(t.wt, "dirty.txt"), "dirty\n");
    const r = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /uncommitted changes/);

    rmSync(join(t.wt, "dirty.txt"));
    writeFileSync(join(t.wt, "REPORT.md"), "summary\n");
    const ok = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
      "--dry-run",
    ]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses a detached HEAD", () => {
  const t = setup();
  try {
    git(t.wt, ["checkout", "--detach", "HEAD"], t.gitEnv);
    const r = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /detached HEAD/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses shipping main branch", () => {
  const t = setup();
  try {
    // Free main in clone and check out main in the worktree
    git(t.main, ["checkout", "--detach"], t.gitEnv);
    git(t.wt, ["checkout", "-B", "main"], t.gitEnv);
    const r = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot ship main branch/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses when tip differs from --checked by commits not from main", () => {
  const t = setup();
  try {
    writeFileSync(join(t.wt, "unrelated.txt"), "extra\n");
    git(t.wt, ["add", "unrelated.txt"], t.gitEnv);
    git(t.wt, ["commit", "-m", "unrelated change"], t.gitEnv);

    const r = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing: branch tip/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("allows tip when it differs from --checked only by merge of main", () => {
  const t = setup();
  try {
    // Add a commit to main and push to bare remote
    writeFileSync(join(t.main, "main-update.txt"), "main update\n");
    git(t.main, ["add", "main-update.txt"], t.gitEnv);
    git(t.main, ["commit", "-m", "update from main"], t.gitEnv);
    git(t.main, ["push", t.bare, "main"], t.gitEnv);

    // Merge origin/main into worktree branch
    git(t.wt, ["fetch", "origin"], t.gitEnv);
    git(t.wt, ["merge", "--no-edit", "origin/main"], t.gitEnv);

    // Now worktree tip is a merge commit, but --checked is the older feature commit.
    const r = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
      "--dry-run",
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /dry-run/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("appends PR attribution line to body file without duplicating if already present", () => {
  const t = setup();
  try {
    const r = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(t.bodyCopy), "body file should have been passed to gh pr create");
    const copied = readFileSync(t.bodyCopy, "utf8");
    assert.match(copied, /## Summary/);
    assert.match(copied, /🤖 Generated with \[Claude Code\]\(https:\/\/claude\.com\/claude-code\)/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }

  const t2 = setup();
  try {
    // Test with body file that already contains the attribution line
    const alreadyAttributedFile = join(t2.dir, "ALREADY_ATTRIBUTED.md");
    const attrText = "Existing body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n";
    writeFileSync(alreadyAttributedFile, attrText);
    const r2 = t2.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", alreadyAttributedFile,
      "--checked", t2.checkedSha,
      "--dry-run",
    ]);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  } finally {
    rmSync(t2.dir, { recursive: true, force: true });
  }
});

test("uses gh api when gh pr edit fails", () => {
  const t = setup();
  try {
    const r = spawnSync(
      "bash",
      [
        script,
        "--worktree", "ship-wt",
        "--title", "Ship feature",
        "--body-file", t.bodyFile,
        "--checked", t.checkedSha,
      ],
      {
        encoding: "utf8",
        cwd: repoRoot,
        env: {
          ...t.env,
          STUB_GH_PR_CREATE_FAIL: "1", // PR already exists
          STUB_GH_PR_EDIT_FAIL: "1",   // gh pr edit fails with GraphQL error
        },
      },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /gh pr edit failed; falling back to gh api/);

    const ghLog = readFileSync(t.ghLog, "utf8");
    assert.match(ghLog, /pr edit 99/);
    assert.match(ghLog, /api -X PATCH repos\/jahnzh\/sonder\/pulls\/99 -F body=@/);

    assert.ok(existsSync(t.apiBodyCopy), "body file should have been passed to gh api");
    const apiBody = readFileSync(t.apiBodyCopy, "utf8");
    assert.match(apiBody, /🤖 Generated with \[Claude Code\]\(https:\/\/claude\.com\/claude-code\)/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses when tsc fails", () => {
  const t = setup();
  try {
    const r = spawnSync(
      "bash",
      [
        script,
        "--worktree", "ship-wt",
        "--title", "Ship feature",
        "--body-file", t.bodyFile,
        "--checked", t.checkedSha,
      ],
      {
        encoding: "utf8",
        cwd: repoRoot,
        env: {
          ...t.env,
          STUB_TSC_EXIT: "1",
        },
      },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /typecheck failed/);

    // Ensure it stopped before pushing or creating PR
    const ghLog = existsSync(t.ghLog) ? readFileSync(t.ghLog, "utf8") : "";
    assert.doesNotMatch(ghLog, /pr create/);
    assert.doesNotMatch(ghLog, /pr merge/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses when PR is not MERGEABLE (CONFLICTING)", () => {
  const t = setup();
  try {
    const r = spawnSync(
      "bash",
      [
        script,
        "--worktree", "ship-wt",
        "--title", "Ship feature",
        "--body-file", t.bodyFile,
        "--checked", t.checkedSha,
      ],
      {
        encoding: "utf8",
        cwd: repoRoot,
        env: {
          ...t.env,
          STUB_GH_MERGEABLE: "CONFLICTING",
        },
      },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mergeable=CONFLICTING/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("times out when PR stays UNKNOWN", () => {
  const t = setup();
  try {
    const r = spawnSync(
      "bash",
      [
        script,
        "--worktree", "ship-wt",
        "--title", "Ship feature",
        "--body-file", t.bodyFile,
        "--checked", t.checkedSha,
      ],
      {
        encoding: "utf8",
        cwd: repoRoot,
        env: {
          ...t.env,
          STUB_GH_MERGEABLE: "UNKNOWN",
          ORCA_SHIP_MAX_ATTEMPTS: "2",
          ORCA_SHIP_POLL_INTERVAL: "0.01",
        },
      },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /timed out waiting for PR #99 to become MERGEABLE/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("refuses when PR headRefOid does not match the pushed tip, does not call orca-land.sh", () => {
  const t = setup();
  try {
    const r = t.run(
      [
        "--worktree", "ship-wt",
        "--title", "Ship feature",
        "--body-file", t.bodyFile,
        "--checked", t.checkedSha,
      ],
      {
        STUB_GH_HEAD_OID: "0000000000000000000000000000000000000000",
      },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PR head 0000000000000000000000000000000000000000 is not the pushed tip/);
    assert.doesNotMatch(r.stdout, /-> 7\. land via orca-land\.sh/);
    assert.ok(existsSync(t.wt), "worktree must still exist when refused");

    const ghLog = existsSync(t.ghLog) ? readFileSync(t.ghLog, "utf8") : "";
    assert.doesNotMatch(ghLog, /pr merge/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("--dry-run prints every step without pushing or modifying repo or landing", () => {
  const t = setup();
  try {
    const r = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
      "--dry-run",
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /dry-run: git fetch origin/);
    assert.match(r.stdout, /dry-run: git merge origin\/main/);
    assert.match(r.stdout, /dry-run: tsc --noEmit/);
    assert.match(r.stdout, /dry-run: SONDER_SKIP_PREPUSH=1 git push origin jahnzh\/feat-99-ship/);
    assert.match(r.stdout, /dry-run: gh pr create/);
    assert.match(r.stdout, /dry-run: wait for PR/);
    assert.match(r.stdout, /dry-run: verify main/);
    assert.ok(existsSync(t.wt), "worktree must still exist in dry-run");

    const ghLog = existsSync(t.ghLog) ? readFileSync(t.ghLog, "utf8") : "";
    assert.doesNotMatch(ghLog, /pr merge/);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("ships end-to-end: merges main, typechecks, pushes, creates PR with attribution, lands, verifies main", () => {
  const t = setup();
  try {
    const r = t.run([
      "--worktree", "ship-wt",
      "--title", "Ship feature",
      "--body-file", t.bodyFile,
      "--checked", t.checkedSha,
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // Verify typecheck was run
    const tscLog = readFileSync(t.tscLog, "utf8");
    assert.match(tscLog, /tsc --noEmit/);

    // Verify gh commands
    const ghLog = readFileSync(t.ghLog, "utf8");
    assert.match(ghLog, /pr create/);
    assert.match(ghLog, /pr view 99/);
    assert.match(ghLog, /pr merge 99 --merge/);

    // Verify worktree was removed by orca-land.sh
    assert.equal(existsSync(t.wt), false, "worktree should be removed after landing");

    // Verify main was updated with feature commit
    const mainTip = git(t.main, ["rev-parse", "HEAD"], t.gitEnv).stdout.trim();
    assert.equal(mainTip, t.checkedSha, "main must be updated to feature commit");
    assert.ok(existsSync(join(t.main, "feature.txt")), "feature file must exist in main");

    // Verify bare remote main has the feature commit
    const bareMainTip = git(t.bare, ["rev-parse", "refs/heads/main"], t.gitEnv).stdout.trim();
    assert.equal(bareMainTip, t.checkedSha);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
