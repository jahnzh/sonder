import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-ebooks-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const { ebookEditions } = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const app = await createApp();
const original = globalThis.fetch;
let sequence = 0;
beforeEach(() => {
  globalThis.fetch = original;
});
after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
test("older clients asking for Anna’s Archive get a clear refusal without any upstream request", async () => {
  globalThis.fetch = async () => {
    throw new Error("No upstream request expected");
  };
  const search = await app.inject("/api/discover/ebooks?source=annas&q=Alice");
  assert.equal(search.statusCode, 400);
  assert.match(search.json().error, /Anna’s Archive is turned off/);
  const save = await app.inject({
    method: "POST",
    url: "/api/ebooks",
    payload: {
      source: "annas",
      md5: "a".repeat(32),
      title: "Alice",
      authors: [],
      extension: "epub",
      language: null,
      size: null,
      year: null,
      coverUrl: null,
      url: `https://annas-archive.gl/md5/${"a".repeat(32)}`,
    },
  });
  assert.equal(save.statusCode, 400);
  assert.match(save.json().error, /Anna’s Archive is turned off/);
});
function upload(filename: string, bytes: Buffer, workId?: string) {
  const boundary = "sonder-ebook-test";
  return app.inject({
    method: "POST",
    url: "/api/ebooks/import" + (workId ? `?workId=${workId}` : ""),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
test("browser-downloaded ebooks persist on the media drive, retain work linkage, deduplicate and download after relaunch", async () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  const uploaded = await upload("Alice.pdf", pdf, "work-alice");
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const id = uploaded.json().id;
  const row = db
    .select()
    .from(ebookEditions)
    .where(eq(ebookEditions.id, id))
    .get()!;
  assert.equal(row.workId, "work-alice");
  assert.ok(row.source.startsWith(join(temp, "media", "ebooks")));
  assert.ok(existsSync(row.source));
  const repeated = await upload("Same-book.pdf", pdf);
  assert.equal(repeated.json().id, id);
  assert.equal(repeated.json().alreadySaved, true);
  const reopened = await createApp();
  try {
    const shelf = await reopened.inject("/api/ebooks");
    assert.ok(
      shelf
        .json()
        .some(
          (book: { id: string; available: boolean }) =>
            book.id === id && book.available,
        ),
    );
    const download = await reopened.inject(`/api/ebooks/${id}/file`);
    assert.deepEqual(download.rawPayload, pdf);
  } finally {
    await reopened.close();
  }
  assert.ok(
    !readdirSync(join(temp, "media", "ebooks")).some((name) =>
      name.endsWith(".part"),
    ),
  );
});
test("invalid ebook uploads and invalid work targets leave no partial files or editions", async () => {
  const count = db.select().from(ebookEditions).all().length;
  const bad = await upload(
    "fake.pdf",
    Buffer.from("<html>Access denied</html>"),
  );
  assert.equal(bad.statusCode, 400);
  const target = await upload(
    "book.pdf",
    Buffer.from("%PDF-1.4\n%%EOF"),
    "missing-work",
  );
  assert.equal(target.statusCode, 400);
  assert.equal(db.select().from(ebookEditions).all().length, count);
  assert.ok(
    !readdirSync(join(temp, "media", "ebooks")).some((name) =>
      name.endsWith(".part"),
    ),
  );
});
