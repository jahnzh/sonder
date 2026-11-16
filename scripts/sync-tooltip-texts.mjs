#!/usr/bin/env node
// Writes src/tooltip-texts.ts from the design's list (docs/design/redesign/tools/tips.mjs), which stays the source.
// Run it after a board change adds or edits a tooltip: node scripts/sync-tooltip-texts.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { T } from "../docs/design/redesign/tools/tips.mjs";

const target = fileURLToPath(new URL("../src/tooltip-texts.ts", import.meta.url));
const current = readFileSync(target, "utf8");
const start = current.indexOf("export const TIPS = {");
const end = current.indexOf("} as const;");
if (start < 0 || end < 0) throw new Error("src/tooltip-texts.ts: the TIPS object was not found");
const entries = Object.entries(T).map(([name, text]) => `  ${name}:\n    ${JSON.stringify(text)},\n`).join("");
const next = `${current.slice(0, start)}export const TIPS = {\n${entries}${current.slice(end)}`;
if (next !== current) writeFileSync(target, next);
console.log(`${Object.keys(T).length} tooltip texts${next === current ? ", already in step" : " written to src/tooltip-texts.ts"}`);
