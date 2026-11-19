import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// The redesign's tokens (#486; spec #480, "Tokens"). The spec's values are written out here, so a change to
// tokens.css that drifts from the spec fails. (src/parts/tokens.ts held the same numbers; nothing imported it, and
// #609 deleted it.)
const css = readFileSync(new URL("../src/parts/tokens.css", import.meta.url), "utf8");
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
function prop(name: string, block = rootBlock): string | undefined {
  return block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
}
function rule(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, selector);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  return Object.fromEntries(
    body
      .split(";")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]),
  );
}

test("six spacing steps: 4, 8, 12, 16, 24, 32", () => {
  for (const step of [4, 8, 12, 16, 24, 32]) assert.equal(prop(`space-${step}`), `${step}px`, `--space-${step}`);
  assert.equal((rootBlock.match(/--space-/g) ?? []).length, 6);
});

test("three corners: 8 for controls, 14 for groups, round", () => {
  assert.equal(prop("corner-control"), "8px");
  assert.equal(prop("corner-group"), "14px");
  assert.equal(prop("corner-round"), "999px");
});

test("three heights: control 44, row 52, bar 64", () => {
  assert.equal(prop("height-control"), "44px");
  assert.equal(prop("height-row"), "52px");
  assert.equal(prop("height-bar"), "64px");
});

test("the screen edge is 16 on a phone and 32 from 760 px on", () => {
  assert.equal(prop("edge"), "16px");
  const desktop = css.slice(css.indexOf("@media (min-width: 760px)"));
  assert.equal(prop("edge", desktop.slice(0, desktop.indexOf("}"))), "32px");
});

test("five text styles with the spec's face, weight, size and line height", () => {
  const spec = {
    title: ["heading", 700, 28, 34, false, 0],
    heading: ["heading", 700, 20, 26, false, 0],
    body: ["body", 400, 16, 22, false, 0],
    label: ["body", 500, 14, 20, false, 0],
    caption: ["body", 600, 12, 16, true, 0.08],
  } as const;
  assert.deepEqual([...css.matchAll(/\.type-([a-z]+)\s*\{/g)].map((match) => match[1]).sort(), Object.keys(spec).sort());
  for (const [name, [family, weight, size, lineHeight, uppercase, tracking]] of Object.entries(spec)) {
    const declared = rule(`.type-${name}`);
    assert.equal(declared["font-family"], `var(--font-${family})`, name);
    assert.equal(declared["font-weight"], String(weight), name);
    assert.equal(declared["font-size"], `${size}px`, name);
    assert.equal(declared["line-height"], `${lineHeight}px`, name);
    assert.equal(declared["text-transform"], uppercase ? "uppercase" : undefined, name);
    assert.equal(declared["letter-spacing"], tracking ? `${tracking}em` : undefined, name);
  }
});

test("the tokens add names and change no colour variable", () => {
  for (const colour of ["background", "surface", "raised", "border", "text", "muted", "accent", "on-accent"])
    assert.equal(prop(colour), undefined, colour);
});
