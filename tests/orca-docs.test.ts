import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("1. Coordinator state file documentation in worker-spec.md", () => {
  const content = readFileSync(join(repoRoot, "docs", "agents", "worker-spec.md"), "utf8");
  assert.match(content, /## Coordinator state/, "worker-spec.md must have Coordinator state section");
  assert.match(content, /artifacts\/orca\/STATE\.md/, "must mention artifacts/orca/STATE.md");
  assert.match(content, /Read artifacts\/orca\/STATE\.md and do its next action/, "must mention exact wakeup prompt");
  assert.match(content, /never paste the run state into the prompt/, "must caution against pasting run state into prompt");
});

test("2. Spec templates exist, contain verbatim rules block and specific requirements", () => {
  const workerSpec = readFileSync(join(repoRoot, "docs", "agents", "worker-spec.md"), "utf8");
  assert.match(
    workerSpec,
    /docs\/agents\/spec-templates\//,
    "worker-spec.md template section must point to spec templates"
  );

  const featurePath = join(repoRoot, "docs", "agents", "spec-templates", "feature.md");
  const reviewPath = join(repoRoot, "docs", "agents", "spec-templates", "review.md");
  const fixPath = join(repoRoot, "docs", "agents", "spec-templates", "fix.md");

  assert.ok(existsSync(featurePath), "feature.md template must exist");
  assert.ok(existsSync(reviewPath), "review.md template must exist");
  assert.ok(existsSync(fixPath), "fix.md template must exist");

  const featureContent = readFileSync(featurePath, "utf8");
  const reviewContent = readFileSync(reviewPath, "utf8");
  const fixContent = readFileSync(fixPath, "utf8");

  // Extract rules block text from worker-spec.md
  const rulesMatch = workerSpec.match(/## Rules block\s+Paste this block at the top of every worker spec:\s+```markdown\n([\s\S]+?)\n```/);
  assert.ok(rulesMatch, "rules block must be present in worker-spec.md");
  const rulesText = rulesMatch[1];

  // Each template must contain the rules block text verbatim (not just an include comment)
  assert.ok(featureContent.includes(rulesText), "feature.md must include rules block verbatim");
  assert.ok(reviewContent.includes(rulesText), "review.md must include rules block verbatim");
  assert.ok(fixContent.includes(rulesText), "fix.md must include rules block verbatim");

  // Placeholders for Model choice and Task
  for (const [name, content] of [["feature.md", featureContent], ["review.md", reviewContent], ["fix.md", fixContent]]) {
    assert.match(content, /## Model choice/, `${name} must have Model choice section`);
    assert.match(content, /## Task/, `${name} must have Task section`);
    assert.match(content, /<model_id>/, `${name} must have model_id placeholder`);
    assert.match(content, /<branch_name>/, `${name} must have branch_name placeholder`);
  }

  // review.md specific requirements
  assert.match(reviewContent, /Read-only/i, "review.md must specify read-only");
  assert.match(reviewContent, /must not edit or commit/i, "review.md must forbid editing and committing");
  assert.match(reviewContent, /BLOCKING/, "review.md must include BLOCKING severity");
  assert.match(reviewContent, /HIGH/, "review.md must include HIGH severity");
  assert.match(reviewContent, /MEDIUM/, "review.md must include MEDIUM severity");
  assert.match(reviewContent, /LOW/, "review.md must include LOW severity");
  assert.match(reviewContent, /30 minutes/, "review.md must require worker_done within 30 minutes");
  assert.match(reviewContent, /Numbered list of what to look hardest at:/, "review.md must have numbered list of focus areas");

  // fix.md specific requirements
  assert.match(fixContent, /Findings to fix/i, "fix.md must have findings to fix section");
  assert.match(fixContent, /Verify each claim against the code before fixing/i, "fix.md must require verifying claims");
  assert.match(fixContent, /fails on the base code and passes after/i, "fix.md must require test failing on base code and passing after");
  assert.match(fixContent, /scripts\/mutate\.mjs/, "fix.md must require mutation proofs from scripts/mutate.mjs");
  assert.match(fixContent, /Skip LOW items unless trivial/i, "fix.md must specify skipping LOW items unless trivial");

  // feature.md specific requirements
  assert.match(featureContent, /Owner defaults for open questions/i, "feature.md must have owner defaults for open questions");
  assert.match(featureContent, /scripts\/mutate\.mjs/, "feature.md must ask for mutation proofs from scripts/mutate.mjs");
});

test("3. Review policy section in worker-spec.md", () => {
  const content = readFileSync(join(repoRoot, "docs", "agents", "worker-spec.md"), "utf8");
  assert.match(content, /## Review policy/, "worker-spec.md must have Review policy section");
  assert.match(content, /keyboard handling/, "must mention keyboard handling");
  assert.match(content, /persistence\/progress/, "must mention persistence/progress");
  assert.match(content, /security/, "must mention security");
  assert.match(content, /shared schemas/, "must mention shared schemas");
  assert.match(content, /different model family/, "must require different model family");
  assert.match(content, /docs\/agents\/spec-templates\/review\.md/, "must reference review.md template");
  assert.match(content, /docs\/agents\/spec-templates\/fix\.md/, "must reference fix.md spec");
  assert.match(content, /final head only/, "Deck run must run on final head only");
});

test("4. Coordinator verification section in worker-spec.md", () => {
  const content = readFileSync(join(repoRoot, "docs", "agents", "worker-spec.md"), "utf8");
  assert.match(content, /## Coordinator verification/, "worker-spec.md must have Coordinator verification section");
  assert.match(content, /merge `main`/i, "must mention merging main");
  assert.match(content, /tsc/i, "must mention tsc");
  assert.match(content, /npm test/i, "must mention npm test");
  assert.match(content, /npm run build/i, "must mention npm run build");
  assert.match(content, /PLAYWRIGHT_PORT/, "must mention PLAYWRIGHT_PORT");
  assert.match(content, /--repeat-each 2/, "must mention --repeat-each 2");
  assert.match(content, /unique title per test/, "must mention unique title per test");
  assert.match(content, /scripts\/mutate\.mjs/, "must mention scripts/mutate.mjs");
  assert.match(content, /scripts\/ci-result\.sh/, "must mention scripts/ci-result.sh");
  assert.match(content, /ONE `ci:deck` at a time/, "must mention ONE ci:deck at a time");
  assert.match(content, /scripts\/orca-land\.sh/, "must mention scripts/orca-land.sh");
});

test("5. Gotchas documented in worker-spec.md and issue-tracker.md", () => {
  const workerSpec = readFileSync(join(repoRoot, "docs", "agents", "worker-spec.md"), "utf8");
  const issueTracker = readFileSync(join(repoRoot, "docs", "agents", "issue-tracker.md"), "utf8");

  // gh pr edit gotcha
  assert.match(issueTracker, /gh pr edit.*fails on this repo.*GraphQL Projects classic deprecation/i);
  assert.match(issueTracker, /gh api -X PATCH repos\/jahnzh\/sonder\/pulls\/<n> -F body=@file/);

  // Mailbox gotcha
  assert.match(workerSpec, /completed dispatch's mailbox is closed, so send to `run:<run_id>`/i);

  // Branch gotcha
  assert.match(workerSpec, /local branch can differ from its remote name, so use `orca-spawn\.sh --base-worktree`/i);

  // Heartbeats gotcha
  assert.match(workerSpec, /heartbeats are hidden by `orca-check\.mjs` unless `--heartbeats`/i);

  // pkill gotcha
  assert.match(workerSpec, /`pkill -f` and `pgrep -f` match their own shell: kill by PID/i);
});

test("6. Liveness playbook in worker-spec.md and models.md pointer", () => {
  const workerSpec = readFileSync(join(repoRoot, "docs", "agents", "worker-spec.md"), "utf8");
  const models = readFileSync(join(repoRoot, "docs", "agents", "models.md"), "utf8");

  assert.match(workerSpec, /## Liveness playbook/, "worker-spec.md must have Liveness playbook section");
  assert.match(workerSpec, /two consecutive empty waits/i);
  assert.match(workerSpec, /orca terminal read --terminal/i);
  assert.match(workerSpec, /stale_status/);
  assert.match(workerSpec, /30 minutes/);
  assert.match(workerSpec, /20 minutes/);
  assert.match(workerSpec, /worker-stop/);
  assert.match(workerSpec, /scripts\/orca-preflight\.sh --after-stop/);
  assert.match(workerSpec, /inspect the worktree/i);

  assert.match(models, /docs\/agents\/worker-spec\.md/, "models.md must point to worker-spec.md liveness playbook");
});

test("7. AGENTS.md references worker-spec.md in at most one line", () => {
  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  const lines = agents.split("\n");
  const matchingLines = lines.filter((l) => l.includes("docs/agents/worker-spec.md") && (l.includes("templates") || l.includes("state")));
  assert.equal(matchingLines.length, 1, "AGENTS.md must add at most ONE line pointing to worker-spec.md for state and templates");
});

test("8. Referenced file paths exist or match allowed list", () => {
  const allowedPendingScripts = new Set([
    "scripts/mutate.mjs",
    "scripts/ci-result.sh",
    "scripts/orca-land.sh",
  ]);

  const filesToCheck = [
    join(repoRoot, "docs", "agents", "worker-spec.md"),
    join(repoRoot, "docs", "agents", "spec-templates", "feature.md"),
    join(repoRoot, "docs", "agents", "spec-templates", "review.md"),
    join(repoRoot, "docs", "agents", "spec-templates", "fix.md"),
    join(repoRoot, "docs", "agents", "models.md"),
    join(repoRoot, "docs", "agents", "issue-tracker.md"),
  ];

  for (const filePath of filesToCheck) {
    const content = readFileSync(filePath, "utf8");
    // Match scripts/foo.ext or docs/foo.ext or artifacts/foo.ext
    const fileMatches = content.matchAll(/(?:scripts|docs)\/[a-zA-Z0-9_\-\.\*\/]+/g);
    for (const match of fileMatches) {
      const relPath = match[0].replace(/[\.,\):`]+$/, "");
      if (allowedPendingScripts.has(relPath)) continue;
      // Skip wildcard patterns like scripts/verify-*.mjs
      if (relPath.includes("*")) continue;
      // Skip markdown link anchors or generic references like docs/ or spec-templates/
      if (relPath === "docs/" || relPath === "docs/agents" || relPath === "docs/adr/") continue;
      const fullPath = join(repoRoot, relPath);
      assert.ok(existsSync(fullPath), `Referenced path ${relPath} in ${filePath} must exist`);
    }
  }
});

