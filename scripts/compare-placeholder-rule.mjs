#!/usr/bin/env node
// Compare the placeholder rule of issue #483 with the id prefix it replaced, on a database
// file: prints the audio editions each names and exits 1 when they differ.
//
// Usage: node scripts/compare-placeholder-rule.mjs <database file>
//
// Old rule: the edition's id starts with `hc-`. New rule (server/placeholder-edition.ts):
// none of the edition's recordings has a track. The file is opened read-only and never
// through server/db.ts, so the script changes nothing, also on a copy of production.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { placeholderEditionSql } from "../server/placeholder-edition.ts";

const USAGE = "usage: node scripts/compare-placeholder-rule.mjs <database file>";

export function comparePlaceholderRule(file) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const ids = (where) =>
      database.prepare(`SELECT e.id FROM audio_editions e WHERE ${where} ORDER BY e.id`).pluck().all();
    const old = ids("substr(e.id,1,3)='hc-'");
    const rule = ids(placeholderEditionSql("e.id"));
    const total = database.prepare("SELECT count(*) FROM audio_editions").pluck().get();
    return {
      total,
      old,
      rule,
      onlyOld: old.filter((id) => !rule.includes(id)),
      onlyRule: rule.filter((id) => !old.includes(id)),
    };
  } finally {
    database.close();
  }
}

function main(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (argv.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  if (!existsSync(argv[0])) {
    console.error(`Database not found: ${argv[0]}`);
    return 2;
  }
  const result = comparePlaceholderRule(argv[0]);
  console.log(`audio editions: ${result.total}`);
  console.log(`old rule (id starts with hc-): ${result.old.length}`);
  for (const id of result.old) console.log(`  ${id}`);
  console.log(`new rule (no recording has a track): ${result.rule.length}`);
  for (const id of result.rule) console.log(`  ${id}`);
  if (!result.onlyOld.length && !result.onlyRule.length) {
    console.log("same: both rules name the same editions");
    return 0;
  }
  console.log(`differ: only old rule: ${result.onlyOld.join(", ") || "none"}`);
  console.log(`differ: only new rule: ${result.onlyRule.join(", ") || "none"}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
