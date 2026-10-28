// Consistent online backup of a Sonder SQLite database.
//
//   node scripts/backup-db.mjs <source-db> <destination-db>
//
// The copy is made with SQLite's online backup API (better-sqlite3 `db.backup`), so committed
// frames that still sit in the -wal file are included and a running server may keep writing
// while the copy proceeds. The database file and its WAL are never copied byte-for-byte.
//
// The destination is created only when the copy is complete and has passed PRAGMA
// integrity_check: the backup is written to a fresh temporary file beside the destination and
// then hard-linked into place, so an existing or concurrently created destination is never
// replaced and a failed run never leaves a file that looks like a valid backup.
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const USAGE = "usage: node scripts/backup-db.mjs <source-db> <destination-db>";

export class BackupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "BackupError";
  }
}

// lstat, not existsSync: a dangling symlink is still an existing destination.
function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function fail(code, detail, options) {
  return new BackupError(`${detail} (${code})`, options);
}

function assertIsDatabase(path, label) {
  let handle;
  try {
    handle = openSync(path, "r");
  } catch (error) {
    throw new BackupError(`cannot read ${label} ${path}: ${error.message}`, { cause: error });
  }
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(handle, header, 0, header.length, 0);
    if (read !== SQLITE_HEADER.length || !header.equals(SQLITE_HEADER))
      throw new BackupError(`${label} is not a SQLite database: ${path}`);
  } finally {
    closeSync(handle);
  }
}

function resolvePaths(sourcePath, destinationPath) {
  if (typeof sourcePath !== "string" || !sourcePath.trim())
    throw new BackupError("source database path is required");
  if (typeof destinationPath !== "string" || !destinationPath.trim())
    throw new BackupError("destination database path is required");

  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);

  let sourceStat;
  try {
    sourceStat = statSync(source);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new BackupError(`source database does not exist: ${source}`, { cause: error });
    throw new BackupError(`cannot read source database ${source}: ${error.message}`, {
      cause: error,
    });
  }
  if (!sourceStat.isFile()) throw new BackupError(`source is not a file: ${source}`);

  const destinationDir = dirname(destination);
  let dirStat;
  try {
    dirStat = statSync(destinationDir);
  } catch (error) {
    throw new BackupError(`destination directory does not exist: ${destinationDir}`, {
      cause: error,
    });
  }
  if (!dirStat.isDirectory())
    throw new BackupError(`destination directory is not a directory: ${destinationDir}`);

  // Compare real paths so `db.sqlite`, `./db.sqlite` and a symlinked directory all collide.
  const canonicalSource = realpathSync(source);
  const canonicalDestination = join(
    realpathSync(destinationDir),
    basename(destination) || destination,
  );
  if (canonicalSource === canonicalDestination)
    throw new BackupError("source and destination are the same file");
  if (pathExists(destination))
    throw new BackupError(`destination already exists: ${destination}`);

  return { source: canonicalSource, destination: canonicalDestination };
}

function reserveTemporary(destination) {
  const directory = dirname(destination);
  const name = basename(destination);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(
      directory,
      `.${name}.backup-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    let handle;
    try {
      handle = openSync(candidate, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw new BackupError(`cannot create backup file in ${directory}: ${error.message}`, {
        cause: error,
      });
    }
    closeSync(handle);
    return candidate;
  }
  throw new BackupError(`cannot create backup file in ${directory}: temporary name collision`);
}

function discardTemporary(path) {
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try {
      unlinkSync(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function openSource(source) {
  let database;
  try {
    database = new Database(source, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new BackupError(`cannot open source database ${source}: ${error.message}`, {
      cause: error,
    });
  }
  try {
    database.pragma("schema_version", { simple: true });
  } catch (error) {
    database.close();
    throw new BackupError(`source is not a readable SQLite database: ${source} (${error.message})`, {
      cause: error,
    });
  }
  return database;
}

function verifyBackup(path) {
  let database;
  try {
    // Read-write on our own temporary file: closing it checkpoints any WAL left by the copy, so
    // the file we publish is self-contained instead of depending on a companion -wal.
    database = new Database(path, { fileMustExist: true });
    const rows = database.pragma("integrity_check");
    const problems = rows
      .map((row) => String(row.integrity_check ?? ""))
      .filter((message) => message !== "ok");
    if (problems.length > 0 || rows.length !== 1)
      throw new BackupError(
        `backup failed PRAGMA integrity_check: ${problems.join("; ") || "no result"}`,
      );
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(`cannot verify backup: ${error.message}`, { cause: error });
  } finally {
    if (database?.open) database.close();
  }

  // A non-empty -wal would mean the verified state lives outside the published file.
  try {
    if (statSync(`${path}-wal`).size > 0)
      throw new BackupError("backup left uncheckpointed data in its write-ahead log");
  } catch (error) {
    if (error instanceof BackupError) throw error;
    if (error.code !== "ENOENT")
      throw new BackupError(`cannot inspect backup log: ${error.message}`, { cause: error });
  }
}

// Publishing is atomic and never replaces another run's destination. A filesystem
// without hard links is rejected rather than exposing a partially copied backup.
function publishBackup(temporary, destination) {
  try {
    linkSync(temporary, destination);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new BackupError(`destination already exists: ${destination}`, {cause: error});
    throw new BackupError(`cannot publish backup ${destination}: ${error.message}`, {cause: error});
  }
}

/**
 * Copy `sourcePath` to `destinationPath` through SQLite's online backup API.
 * Throws BackupError on any failure; the destination only exists for a verified backup.
 */
export async function backupDatabase(sourcePath, destinationPath) {
  const { source, destination } = resolvePaths(sourcePath, destinationPath);
  assertIsDatabase(source, "source");

  let sourceDatabase = null;
  let temporary = null;
  try {
    sourceDatabase = openSource(source);
    temporary = reserveTemporary(destination);
    await sourceDatabase.backup(temporary);
    sourceDatabase.close();
    sourceDatabase = null;

    verifyBackup(temporary);
    publishBackup(temporary, destination);
    const published = temporary;
    temporary = null;
    // The destination is already valid; a leftover temp file is cosmetic.
    try {
      discardTemporary(published);
    } catch {
      /* ignore: the backup itself succeeded */
    }

    return { source, destination, bytes: statSync(destination).size };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw fail(error.code ?? "BACKUP_FAILED", error.message, { cause: error });
  } finally {
    if (sourceDatabase?.open) {
      try {
        sourceDatabase.close();
      } catch {
        /* ignore close errors: the backup already failed */
      }
    }
    if (temporary) {
      try {
        discardTemporary(temporary);
      } catch {
        /* ignore cleanup errors: the backup already failed */
      }
    }
  }
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const result = await backupDatabase(args[0], args[1]);
    process.stdout.write(`backup-db: wrote ${result.destination} (${result.bytes} bytes)\n`);
    return 0;
  } catch (error) {
    const message = error instanceof BackupError ? error.message : String(error?.message ?? error);
    process.stderr.write(`backup-db: ${message}\n`);
    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`backup-db: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
