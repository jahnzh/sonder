// Which Playwright projects a browser spec runs in besides chromium, declared in the spec itself (#793).
// A spec's first line names them: `// @projects firefox, mobile-chrome`. playwright.config.ts scans tests/e2e once at load
// and builds each project's testMatch from these lines, so adding a spec to a project touches only the spec file.
// chromium runs every spec and is never named. A spec without the line runs in chromium only.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Every project a spec may name, in the order playwright.config.ts defines them. Some exist only on a host with the
// browser binary or with SONDER_MOBILE / SONDER_SLICE_WEBKIT set; a spec may name them all the same.
export const SPEC_PROJECTS = [
  "firefox",
  "webkit",
  "mobile-chrome",
  "mobile-firefox",
  "mobile-safari",
  "webkit-iphone-page-turn",
  "webkit-iphone-activity",
  "mobile-iphone-slice13",
  "mobile-iphone-slice13-sw",
  "webkit-iphone-now-playing",
  "mobile-iphone-series",
  "mobile-iphone-series-sw",
  "mobile-iphone-slice14",
  "mobile-iphone-slice14-sw",
] as const;
export type SpecProject = (typeof SPEC_PROJECTS)[number];

const DECLARATION = /^\/\/ @projects (.*)$/;

export type SpecDeclarations = {
  // Spec file name (e.g. "app.spec.ts") to the projects it names, in the order written.
  projects: Map<string, string[]>;
  // One line per problem: an unknown or repeated name, chromium named, an empty or misplaced line.
  errors: string[];
};

export function readSpecProjects(dir: string): SpecDeclarations {
  const known = new Set<string>(SPEC_PROJECTS);
  const projects = new Map<string, string[]>();
  const errors: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".spec.ts")).sort()) {
    const lines = readFileSync(path.join(dir, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (index > 0 && line.includes("@projects")) errors.push(`${file}:${index + 1}: @projects must be the first line`);
    });
    const match = DECLARATION.exec(lines[0].trimEnd());
    if (!match) {
      if (lines[0].includes("@projects")) errors.push(`${file}:1: write the line as "// @projects name, name"`);
      projects.set(file, []);
      continue;
    }
    const names = match[1].split(",").map((name) => name.trim());
    const seen = new Set<string>();
    for (const name of names) {
      if (name === "") errors.push(`${file}:1: an empty project name`);
      else if (name === "chromium") errors.push(`${file}:1: chromium runs every spec; do not name it`);
      else if (!known.has(name)) errors.push(`${file}:1: no project is named "${name}" (tests/spec-projects.ts lists them)`);
      else if (seen.has(name)) errors.push(`${file}:1: "${name}" is named twice`);
      seen.add(name);
    }
    projects.set(file, names.filter((name) => known.has(name)));
  }
  return { projects, errors };
}

export function specsOf(declarations: SpecDeclarations, project: SpecProject): string[] {
  return [...declarations.projects].filter(([, names]) => names.includes(project)).map(([file]) => file);
}

// A testMatch that matches exactly the given spec file names in the test directory, and nothing when there are none.
export function testMatchOf(files: string[]): RegExp {
  if (files.length === 0) return /$^/;
  const escaped = files.map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(^|[\\\\/])(${escaped.join("|")})$`);
}

// Reads the declarations once and gives each project's testMatch; throws on the first load if a declaration is wrong,
// so a typo stops the run instead of dropping the spec from a project.
export function projectMatcher(dir: string): (project: SpecProject) => RegExp {
  const declarations = readSpecProjects(dir);
  if (declarations.errors.length) throw new Error(`Spec project declarations (#793):\n${declarations.errors.join("\n")}`);
  return (project) => testMatchOf(specsOf(declarations, project));
}
