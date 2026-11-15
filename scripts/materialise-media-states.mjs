#!/usr/bin/env node
// Write each work's derived media state back into the stored columns of work_media_states
// (ADR 0011), so an image from before that ADR, which reads those columns, shows the same
// states. Run it before rolling back to such an image (docs/LOCAL_CHECKS.md).
//
// Usage: node scripts/materialise-media-states.mjs [--db <path>] [--dry-run]
//
// The database defaults to $DATA_DIR/sonder.db (DATA_DIR defaults to ./data), as
// scripts/alignment-status.mjs and scripts/deploy.sh do. The script opens the file directly
// and never loads server/db.ts, so it works while the server is running (it waits for the
// write lock) and when the server cannot start. --dry-run opens it read-only and only counts.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { materialiseWorkMediaStates } from "../server/work-media-derivation.ts";

const USAGE = "usage: node scripts/materialise-media-states.mjs [--db <path>] [--dry-run]";

export function defaultDbPath(env = process.env) {
  return path.resolve(env.DATA_DIR || "data", "sonder.db");
}

export function parseArgs(argv) {
  const options = { db: defaultDbPath(), dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--db" && argv[index + 1]) options.db = path.resolve(argv[++index]);
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return options;
}

export function run(options) {
  if (!existsSync(options.db)) throw new Error(`Database not found: ${options.db}`);
  const database = new Database(options.db, {
    readonly: options.dryRun,
    fileMustExist: true,
    timeout: 15000,
  });
  try {
    database.pragma("foreign_keys = ON");
    return materialiseWorkMediaStates(database, { dryRun: options.dryRun });
  } finally {
    database.close();
  }
}

export function describe(result, dbPath) {
  const changed = result.inserted + result.updated;
  const verb = result.dryRun ? "would write" : "wrote";
  return (
    `${dbPath}: ${verb} ${changed} work_media_states rows ` +
    `(${result.inserted} inserted, ${result.updated} updated, ${result.unchanged} unchanged)` +
    (result.dryRun ? "; dry run, nothing written" : "")
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
    } else {
      console.log(describe(run(options), options.db));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
