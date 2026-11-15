import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error The backup command is plain JavaScript without type declarations.
import { BackupError, backupDatabase } from "../scripts/backup-db.mjs";
import * as shared from "../server/db-backup.mjs";

// Same dynamic-import pattern as tests/users.test.ts: better-sqlite3 is CommonJS.
const { default: Database } = (await import("better-sqlite3")) as typeof import("better-sqlite3") & {
  default: typeof import("better-sqlite3");
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "backup-db.mjs");
const isRoot = process.getuid?.() === 0;

function tempDir(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `sonder-backup-db-${name}-`));
  return dir;
}

// Mirrors production: WAL, autocheckpoint disabled, so committed rows stay in the -wal file.
function createSource(dir: string, name = "source.db") {
  const path = join(dir, name);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "CREATE TABLE items(id INTEGER PRIMARY KEY, marker TEXT NOT NULL);",
  );
  const insert = db.prepare("INSERT INTO items(marker) VALUES (?)");
  const seed = db.transaction((rows: string[]) => {
    for (const marker of rows) insert.run(marker);
    db.prepare("INSERT INTO settings(key, value) VALUES ('seeded', ?)").run(String(rows.length));
  });
  seed(["wal-row-1", "wal-row-2", "wal-row-3"]);
  return { path, db };
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertNoTemporaries(dir: string) {
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".backup-")),
    [],
    "no partial backup files left behind",
  );
}

function readAll(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      integrity: db.pragma("integrity_check", { simple: true }),
      rows: db.prepare("SELECT count(*) AS n FROM items").get() as { n: number },
      markers: db
        .prepare("SELECT marker FROM items ORDER BY id")
        .all()
        .map((row) => (row as { marker: string }).marker),
      settings: db.prepare("SELECT count(*) AS n FROM settings").get() as { n: number },
    };
  } finally {
    db.close();
  }
}

test("backup captures commits still in the WAL while another connection is open", async () => {
  const dir = tempDir("wal");
  const source = createSource(dir);
  const destination = join(dir, "backup.db");
  try {
    const wal = `${source.path}-wal`;
    assert.ok(statSync(wal).size > 0, "committed rows are still in the -wal file");
    assert.ok(
      !readFileSync(source.path).includes("wal-row-3"),
      "main database file alone does not contain the WAL-only row",
    );
    assert.ok(readFileSync(wal).includes("wal-row-3"));

    // A second connection holds the source open for the duration of the backup.
    const observer = new Database(source.path, { readonly: true, fileMustExist: true });
    try {
      const beforeHash = sha256(source.path);
      const beforeWalHash = sha256(wal);
      const beforeSize = statSync(source.path).size;
      const beforeCount = (
        observer.prepare("SELECT count(*) AS n FROM items").get() as { n: number }
      ).n;
      assert.equal(beforeCount, 3);

      const result = await backupDatabase(source.path, destination);
      assert.equal(result.destination, destination);

      // The backup is self-contained at publish time: no -wal or -shm of its own.
      assert.equal(existsSync(`${destination}-wal`), false, "backup has no side WAL file");
      assert.equal(existsSync(`${destination}-shm`), false, "backup has no side WAL index");

      const copied = readAll(destination);
      assert.equal(copied.integrity, "ok");
      assert.equal(copied.rows.n, 3, "every committed row reached the backup");
      assert.deepEqual(copied.markers, ["wal-row-1", "wal-row-2", "wal-row-3"]);
      assert.equal(copied.settings.n, 1);
      assert.equal(copied.rows.n, beforeCount);

      // Source untouched and still writable, and the other connection keeps its view.
      assert.equal(sha256(source.path), beforeHash, "backup did not rewrite the source file");
      assert.equal(sha256(wal), beforeWalHash, "backup did not checkpoint the source WAL away");
      assert.equal(statSync(source.path).size, beforeSize);
      source.db.prepare("INSERT INTO items(marker) VALUES ('after-backup')").run();
      assert.equal((observer.prepare("SELECT count(*) AS n FROM items").get() as { n: number }).n, 4);
      assert.equal(readAll(source.path).markers.at(-1), "after-backup");
      assertNoTemporaries(dir);
    } finally {
      observer.close();
    }
  } finally {
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup includes writes committed by another connection just before it starts", async () => {
  const dir = tempDir("second-connection");
  const source = createSource(dir);
  const destination = join(dir, "backup.db");
  try {
    const other = new Database(source.path);
    other.pragma("wal_autocheckpoint = 0");
    other.prepare("INSERT INTO items(marker) VALUES ('from-second-connection')").run();
    other.close();
    assert.ok(statSync(`${source.path}-wal`).size > 0);

    await backupDatabase(source.path, destination);
    const copied = readAll(destination);
    assert.equal(copied.integrity, "ok");
    assert.equal(copied.rows.n, 4);
    assert.ok(copied.markers.includes("from-second-connection"));
  } finally {
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing source is rejected without creating a source or destination", async () => {
  const dir = tempDir("missing");
  const missing = join(dir, "absent.db");
  const destination = join(dir, "backup.db");
  try {
    await assert.rejects(backupDatabase(missing, destination), (error: Error) => {
      assert.ok(error instanceof BackupError, "typed backup error");
      assert.match(error.message, /source database does not exist/);
      return true;
    });
    assert.equal(existsSync(missing), false, "missing source was not initialized");
    assert.equal(existsSync(destination), false);
    assertNoTemporaries(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source and destination may not be the same file", async () => {
  const dir = tempDir("same");
  const source = createSource(dir);
  const aliasDir = join(dir, "alias");
  try {
    symlinkSync(dir, aliasDir);
    const before = sha256(source.path);
    for (const destination of [
      source.path,
      join(dir, ".", "source.db"),
      join(aliasDir, "source.db"),
    ]) {
      await assert.rejects(backupDatabase(source.path, destination), (error: Error) => {
        assert.ok(error instanceof BackupError);
        assert.match(error.message, /same file/);
        return true;
      });
    }
    assert.equal(sha256(source.path), before, "source left byte-identical");
    assert.equal(readAll(source.path).rows.n, 3);
    assertNoTemporaries(dir);
  } finally {
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing destination is preserved untouched", async () => {
  const dir = tempDir("existing");
  const source = createSource(dir);
  const destination = join(dir, "backup.db");
  try {
    const original = Buffer.from("previous backup, must not be replaced");
    writeFileSync(destination, original);
    await assert.rejects(backupDatabase(source.path, destination), (error: Error) => {
      assert.ok(error instanceof BackupError);
      assert.match(error.message, /destination already exists/);
      return true;
    });
    assert.deepEqual(readFileSync(destination), original, "existing destination kept its bytes");
    assertNoTemporaries(dir);

    // A directory in the destination slot is also an existing destination.
    const occupied = join(dir, "occupied");
    mkdirSync(occupied);
    await assert.rejects(backupDatabase(source.path, occupied), /destination already exists/);
    assert.ok(statSync(occupied).isDirectory());
  } finally {
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent runs cannot reuse the same destination", async () => {
  const dir = tempDir("concurrent-destination");
  const source = createSource(dir);
  const destination = join(dir, "backup.db");
  try {
    const settled = await Promise.allSettled([
      backupDatabase(source.path, destination),
      backupDatabase(source.path, destination),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one run owns the destination");
    assert.equal(rejected.length, 1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    assert.ok(reason instanceof BackupError);
    assert.match(reason.message, /destination already exists/);
    const copied = readAll(destination);
    assert.equal(copied.integrity, "ok");
    assert.equal(copied.rows.n, 3);
    assertNoTemporaries(dir);
  } finally {
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unwritable, missing and invalid destinations fail without writing a backup", async () => {
  const dir = tempDir("bad-target");
  const source = createSource(dir);
  const readOnlyDir = join(dir, "read-only");
  try {
    mkdirSync(readOnlyDir);
    chmodSync(readOnlyDir, 0o500);

    if (!isRoot) {
      const blocked = join(readOnlyDir, "backup.db");
      await assert.rejects(backupDatabase(source.path, blocked), (error: Error) => {
        assert.ok(error instanceof BackupError);
        assert.match(error.message, /cannot create backup file/);
        return true;
      });
      assert.equal(existsSync(blocked), false);
      assert.deepEqual(readdirSync(readOnlyDir), []);
    }

    const missingDir = join(dir, "no-such-dir", "backup.db");
    await assert.rejects(backupDatabase(source.path, missingDir), /destination directory does not exist/);
    assert.equal(existsSync(join(dir, "no-such-dir")), false);

    const notADir = join(dir, "plain-file");
    writeFileSync(notADir, "not a directory");
    await assert.rejects(
      backupDatabase(source.path, join(notADir, "backup.db")),
      /destination directory is not a directory/,
    );
    assert.equal(readFileSync(notADir, "utf8"), "not a directory");
    assertNoTemporaries(dir);
  } finally {
    chmodSync(readOnlyDir, 0o700);
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source that is not a database is rejected and left untouched", async () => {
  const dir = tempDir("bad-source");
  try {
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "this is definitely not a SQLite database file");
    await assert.rejects(backupDatabase(junk, join(dir, "a.db")), /not a SQLite database/);
    assert.equal(existsSync(join(dir, "a.db")), false);
    assert.equal(readFileSync(junk, "utf8"), "this is definitely not a SQLite database file");

    const empty = join(dir, "empty.db");
    writeFileSync(empty, "");
    await assert.rejects(backupDatabase(empty, join(dir, "b.db")), /not a SQLite database/);
    assert.equal(statSync(empty).size, 0);
    assert.equal(existsSync(join(dir, "b.db")), false);
    assert.equal(existsSync(join(dir, "empty.db-wal")), false, "no WAL side files were created");
    assertNoTemporaries(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "writes committed during the backup leave a consistent snapshot",
  { timeout: 90_000 },
  async () => {
    const dir = tempDir("concurrent-writes");
    const sourcePath = join(dir, "source.db");
    const destination = join(dir, "backup.db");
    const writer = new Database(sourcePath);
    // Bounded in rows and bytes: 25 rows per commit, at most 40 commits, 4 KiB each.
    const batch = 25;
    const maxCommits = 40;
    const payload = Buffer.alloc(4 * 1024, 7);
    let commits = 0;
    let commitsDuringCopy = 0;
    let inFlight = false;
    let stopped = false;
    let pump: NodeJS.Immediate | undefined;
    const deadline = Date.now() + 60_000;

    const stopPump = () => {
      stopped = true;
      if (pump) clearImmediate(pump);
    };

    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      // Items and meta change in the same transaction, so a partial copy would disagree.
      writer.exec(
        "CREATE TABLE items(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);" +
          "CREATE TABLE meta(total INTEGER NOT NULL);" +
          "INSERT INTO meta(rowid, total) VALUES (1, 0);",
      );
      const insert = writer.prepare("INSERT INTO items(payload) VALUES (?)");
      const bump = writer.prepare("UPDATE meta SET total = total + ?");
      const seed = writer.transaction((count: number) => {
        for (let i = 0; i < count; i += 1) insert.run(payload);
        bump.run(count);
      });
      const total = () =>
        (writer.prepare("SELECT total FROM meta").get() as { total: number }).total;

      seed(400);
      assert.equal(total(), 400);

      // Commit once per event-loop turn while the copy runs. The pump is bounded by maxCommits
      // and its own deadline, so it stops even if the copy finishes or stalls.
      const commit = () => {
        if (stopped || commits >= maxCommits || Date.now() > deadline) return;
        seed(batch);
        commits += 1;
        if (inFlight) commitsDuringCopy += 1;
        pump = setImmediate(commit);
        pump.unref();
      };

      const before = total();
      pump = setImmediate(commit);
      pump.unref();
      inFlight = true;
      await backupDatabase(sourcePath, destination);
      inFlight = false;
      stopPump();
      const after = total();

      assert.ok(commits > 0, "the pump committed at least once");
      assert.ok(commitsDuringCopy > 0, "commits landed while the copy was in flight");
      assert.ok(after > before, "source kept accepting writes during the backup");

      const copied = new Database(destination, { readonly: true, fileMustExist: true });
      try {
        assert.equal(copied.pragma("integrity_check", { simple: true }), "ok");
        const rows = (copied.prepare("SELECT count(*) AS n FROM items").get() as { n: number }).n;
        const meta = (copied.prepare("SELECT total FROM meta").get() as { total: number }).total;
        assert.equal(rows, meta, "items and meta agree in the snapshot");
        assert.ok(rows > before, "snapshot includes commits made after the copy began");
        assert.ok(rows <= after, "snapshot cannot contain rows committed after it finished");
        assert.equal(rows % batch, 0, "snapshot sits on a transaction boundary");
      } finally {
        copied.close();
      }

      // The source is still a healthy, writable database afterwards.
      seed(batch);
      const reopened = new Database(sourcePath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(reopened.pragma("integrity_check", { simple: true }), "ok");
      } finally {
        reopened.close();
      }
      assertNoTemporaries(dir);
    } finally {
      stopPump();
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("npm run backup and the server's daily backups use one backup function (#361)", () => {
  assert.equal(backupDatabase, shared.backupDatabase);
  assert.equal(BackupError, shared.BackupError);
});

test("CLI exits nonzero on failure and zero only for a written backup", () => {
  const dir = tempDir("cli");
  const source = createSource(dir);
  const destination = join(dir, "backup.db");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 60_000 });
  try {
    const usage = run();
    assert.notEqual(usage.status, 0);
    assert.match(usage.stderr, /usage: node scripts\/backup-db\.mjs/);

    const missing = join(dir, "absent.db");
    const missingResult = run(missing, join(dir, "from-missing.db"));
    assert.equal(missingResult.status, 1);
    assert.match(missingResult.stderr, /source database does not exist/);
    assert.equal(existsSync(missing), false, "CLI did not create the missing source");
    assert.equal(existsSync(join(dir, "from-missing.db")), false);

    const junk = join(dir, "junk.db");
    writeFileSync(junk, "not a database");
    const junkResult = run(junk, join(dir, "from-junk.db"));
    assert.equal(junkResult.status, 1);
    assert.match(junkResult.stderr, /not a SQLite database/);
    assert.equal(existsSync(join(dir, "from-junk.db")), false);

    const sameResult = run(source.path, source.path);
    assert.equal(sameResult.status, 1);
    assert.match(sameResult.stderr, /same file/);

    const first = run(source.path, destination);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /backup-db: wrote/);
    assert.equal(readAll(destination).integrity, "ok");

    const before = sha256(destination);
    const again = run(source.path, destination);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /destination already exists/);
    assert.equal(sha256(destination), before, "failed run did not replace the good backup");
    assertNoTemporaries(dir);
  } finally {
    source.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
