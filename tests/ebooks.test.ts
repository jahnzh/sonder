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
const { settings, ebookEditions } = await import("../server/schema.ts");
const { encrypt } = await import("../server/security.ts");
const { eq } = await import("drizzle-orm");
const app = await createApp();
const original = globalThis.fetch;
let sequence = 0;
beforeEach(() => {
  globalThis.fetch = original;
  const value = encrypt(`non-member-secret-${++sequence}`);
  db.insert(settings)
    .values({ key: "annas", value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
});
after(async () => {
  globalThis.fetch = original;
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
const resultHtml = `<section><article><a class="js-vim-focus" href="/md5/${"a".repeat(32)}">Alice</a><div>English [en] · EPUB · 1MB · 2020</div></article></section>`;
test("accepted non-member key produces a browser-search handoff instead of a 403 or invalid-key error", async () => {
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.ok(!String(url).includes("secret"));
    if (String(url).endsWith("/account/"))
      return new Response(null, {
        status: 302,
        headers: {
          "set-cookie": "aa_account_id2=free-session; HttpOnly",
          location: "/account/",
        },
      });
    assert.equal(
      new Headers(init?.headers).get("Cookie"),
      "aa_account_id2=free-session",
    );
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: "/search?q=carl&check=1" },
    });
  };
  const response = await app.inject("/api/discover/ebooks?source=annas&q=carl");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().browserRequired, true);
  assert.equal(response.json().accountAccepted, true);
  assert.match(response.json().notice, /account key was accepted/);
  assert.match(response.json().notice, /non-member key/);
  assert.equal(new URL(response.json().website).searchParams.get("q"), "carl");
  assert.doesNotMatch(response.body, /secret|free-session/);
  assert.equal(requests, 2); // Never chase the browser-check redirect loop.
});
test("DDoS cookies alone never count as an accepted account key", async () => {
  globalThis.fetch = async () =>
    new Response("Login form", {
      headers: { "set-cookie": "__ddg1_=challenge; HttpOnly" },
    });
  const response = await app.inject(
    "/api/discover/ebooks?source=annas&q=Alice",
  );
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /did not accept this account key/);
});
test("anonymous verification and HTML challenges return a browser handoff without pretending there are no matches", async () => {
  db.delete(settings).where(eq(settings.key, "annas")).run();
  globalThis.fetch = async (url) => {
    assert.ok(!String(url).includes("/account/"));
    return new Response("<title>DDoS-Guard</title>Checking your browser", {
      status: 200,
    });
  };
  const response = await app.inject(
    "/api/discover/ebooks?source=annas&q=Alice",
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().browserRequired, true);
  assert.equal(response.json().accountAccepted, false);
});
test("member search works and an expired cached session is renewed once", async () => {
  let logins = 0,
    stale = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/account/")) {
      logins++;
      stale = false;
      return new Response(null, {
        status: 302,
        headers: { "set-cookie": `aa_account_id2=session-${logins}; HttpOnly` },
      });
    }
    assert.equal(
      new Headers(init?.headers).get("Cookie"),
      `aa_account_id2=session-${logins}`,
    );
    return stale
      ? new Response("Blocked", { status: 403 })
      : new Response(resultHtml);
  };
  const first = await app.inject("/api/discover/ebooks?source=annas&q=Alice");
  assert.equal(first.json().files[0].title, "Alice");
  stale = true;
  const second = await app.inject("/api/discover/ebooks?source=annas&q=Alice");
  assert.equal(second.json().files.length, 1);
  assert.equal(logins, 2);
});
test("a non-member fast-download refusal explains membership and offers file import without exposing provider details", async () => {
  globalThis.fetch = async () =>
    new Response("<title>Forbidden</title>", { status: 403 });
  const response = await app.inject({
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
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /active membership/);
  assert.match(response.json().error, /free downloads/);
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
