import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_PROJECTS, projectMatcher, readSpecProjects, specsOf, testMatchOf } from "./spec-projects.ts";

const e2e = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e");

function specDir(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "sonder-spec-projects-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

test("every spec in tests/e2e names only projects that exist, on its first line", () => {
  const { errors, projects } = readSpecProjects(e2e);
  assert.deepEqual(errors, []);
  assert.ok(projects.size > 0);
});

test("a spec that names a project that does not exist, chromium, a name twice or the line below the first is refused", () => {
  const dir = specDir({
    "good.spec.ts": "// @projects firefox, mobile-chrome\nimport {test} from \"@playwright/test\";\n",
    "typo.spec.ts": "// @projects firefox, mobile-iphone-slice41\n",
    "chromium.spec.ts": "// @projects chromium\n",
    "twice.spec.ts": "// @projects webkit, webkit\n",
    "empty.spec.ts": "// @projects firefox,\n",
    "late.spec.ts": "import {test} from \"@playwright/test\";\n// @projects firefox\n",
    "loose.spec.ts": "//@projects firefox\n",
    "helper.ts": "// @projects nothing, this is not a spec\n",
  });
  try {
    const { errors, projects } = readSpecProjects(dir);
    assert.deepEqual(errors, [
      'chromium.spec.ts:1: chromium runs every spec; do not name it',
      'empty.spec.ts:1: an empty project name',
      'late.spec.ts:2: @projects must be the first line',
      'loose.spec.ts:1: write the line as "// @projects name, name"',
      'twice.spec.ts:1: "webkit" is named twice',
      'typo.spec.ts:1: no project is named "mobile-iphone-slice41" (tests/spec-projects.ts lists them)',
    ]);
    assert.deepEqual(projects.get("good.spec.ts"), ["firefox", "mobile-chrome"]);
    assert.deepEqual(projects.get("late.spec.ts"), []);
    assert.equal(projects.has("helper.ts"), false);
    assert.throws(() => projectMatcher(dir), /no project is named "mobile-iphone-slice41"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a project's testMatch matches exactly the specs that name it", () => {
  const dir = specDir({
    "app.spec.ts": "// @projects firefox\n",
    "x-app.spec.ts": "// @projects webkit\n",
    "plain.spec.ts": "import {test} from \"@playwright/test\";\n",
  });
  try {
    const declarations = readSpecProjects(dir);
    assert.deepEqual(specsOf(declarations, "firefox"), ["app.spec.ts"]);
    const firefox = projectMatcher(dir)("firefox");
    assert.equal(firefox.test(path.join(dir, "app.spec.ts")), true);
    assert.equal(firefox.test(path.join(dir, "x-app.spec.ts")), false);
    assert.equal(firefox.test(path.join(dir, "plain.spec.ts")), false);
    assert.equal(firefox.test(path.join(dir, "app.spec.ts.orig")), false);
    assert.equal(projectMatcher(dir)("mobile-safari").test(path.join(dir, "plain.spec.ts")), false);
    for (const file of ["app.spec.ts", "x-app.spec.ts", "plain.spec.ts"]) assert.equal(testMatchOf([]).test(path.join(dir, file)), false, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("playwright.config.ts gives each project exactly the specs that declare it", async () => {
  // Every optional project: the phone ones and the slices' WebKit ones.
  process.env.SONDER_MOBILE = "1";
  process.env.SONDER_SLICE_WEBKIT = "1";
  const { firefox, webkit } = await import("@playwright/test");
  const config = (await import("../playwright.config.ts")).default;
  const projects = config.projects ?? [];
  const names = projects.map((project) => project.name);
  assert.equal(names[0], "chromium");
  assert.equal(projects[0].testMatch, undefined, "chromium runs every spec");
  for (const name of names.slice(1)) assert.ok((SPEC_PROJECTS as readonly string[]).includes(name ?? ""), `${name} is in SPEC_PROJECTS`);
  if (existsSync(firefox.executablePath()) && existsSync(webkit.executablePath()))
    assert.deepEqual([...names.slice(1)].sort(), [...SPEC_PROJECTS].sort(), "SPEC_PROJECTS names every project of the config");
  const declarations = readSpecProjects(e2e);
  const files = readdirSync(e2e).filter((name) => name.endsWith(".spec.ts"));
  for (const project of projects.slice(1)) {
    assert.ok(project.testMatch instanceof RegExp, `${project.name} has one testMatch`);
    assert.equal(project.testIgnore, undefined, `${project.name} has no testIgnore: a spec that should not run there does not name it`);
    const matched = files.filter((file) => (project.testMatch as RegExp).test(path.join(e2e, file))).sort();
    assert.deepEqual(matched, specsOf(declarations, project.name as (typeof SPEC_PROJECTS)[number]).sort(), project.name);
  }
});
