import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
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
const { extractBook } = await import("../server/reader.ts");
const { readerFixture } = await import("./reader-fixture.ts");
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
test("Anna’s Archive without a key in Settings is refused plainly, without any upstream request (#901)", async () => {
  globalThis.fetch = async () => {
    throw new Error("No upstream request expected");
  };
  const search = await app.inject("/api/discover/ebooks?source=annas&q=Alice");
  assert.equal(search.statusCode, 400);
  assert.equal(search.json().error, "Add your Anna’s Archive key in Settings first.");
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
  assert.equal(save.json().error, "Add your Anna’s Archive key in Settings first.");
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
const { works } = await import("../server/schema.ts");
const { saveEbook, ebookTimeouts } = await import("../server/ebooks.ts");
const { createHash } = await import("node:crypto");
const { unlinkSync } = await import("node:fs");
function libgen(content: Buffer, workId?: string) {
  const md5 = createHash("md5").update(content).digest("hex");
  return {
    md5,
    source: "libgen" as const,
    title: "Mirror ebook",
    authors: ["Test author"],
    extension: "epub",
    language: "English",
    size: "1 KB",
    year: "2020",
    coverUrl: null,
    url: "https://libgen.li/ads.php?md5=" + md5,
    workId,
  };
}
// The mirror page links to a public address; the body comes from `body`.
function mirror(content: Buffer, body: (signal?: AbortSignal | null) => ReadableStream | Buffer) {
  let downloads = 0;
  globalThis.fetch = async (input, init) => {
    const md5 = createHash("md5").update(content).digest("hex");
    if (String(input).includes("/ads.php?"))
      return new Response(
        `<a href="https://1.1.1.1/get.php?md5=${md5}&amp;key=test">GET</a>`,
      );
    downloads++;
    return new Response(body(init?.signal) as BodyInit, {
      headers: { "Content-Length": String(content.length) },
    });
  };
  return () => downloads;
}
function addWork(id: string) {
  db.insert(works)
    .values({
      id,
      title: id,
      author: "Test author",
      description: "",
      genre: "Audiobook",
      year: 2026,
    })
    .onConflictDoNothing()
    .run();
}
test("r4#3: saving an already-saved ebook for an audiobook links it to that audiobook", async () => {
  addWork("work-target");
  const pdf = Buffer.from(`%PDF-1.4\n% relink ${sequence++}\n%%EOF\n`);
  const standalone = await upload("Relink.pdf", pdf);
  const id = standalone.json().id;
  const before = db.select().from(ebookEditions).where(eq(ebookEditions.id, id)).get()!;
  const mtimePdfBefore = statSync(before.source).mtimeMs;
  assert.notEqual(before.workId, "work-target");
  const again = await upload("Relink.pdf", pdf, "work-target");
  assert.equal(again.json().alreadySaved, true);
  assert.equal(
    db.select().from(ebookEditions).where(eq(ebookEditions.id, id)).get()!.workId,
    "work-target",
  );
  assert.equal(statSync(before.source).mtimeMs, mtimePdfBefore);

  const validEpub = await readerFixture();
  const upEpub = await upload("Relink.epub", validEpub);
  const epubId = upEpub.json().id;
  const epubRow = db.select().from(ebookEditions).where(eq(ebookEditions.id, epubId)).get()!;
  const parsedBefore = await extractBook(epubId);
  assert.notEqual(parsedBefore.workId, "work-target");
  const mtimeEpubBefore = statSync(epubRow.source).mtimeMs;

  const upEpubAgain = await upload("Relink.epub", validEpub, "work-target");
  assert.equal(upEpubAgain.json().alreadySaved, true);
  assert.equal(
    db.select().from(ebookEditions).where(eq(ebookEditions.id, epubId)).get()!.workId,
    "work-target",
  );
  assert.equal(statSync(epubRow.source).mtimeMs, mtimeEpubBefore);
  const parsedAfter = await extractBook(epubId);
  assert.equal(parsedAfter.workId, "work-target");

  const epub = Buffer.from(`PK\x03\x04 libgen relink ${sequence++}`);
  mirror(epub, () => epub);
  const saved = await saveEbook(libgen(epub));
  await saveEbook(libgen(epub, "work-target"));
  assert.equal(
    db.select().from(ebookEditions).where(eq(ebookEditions.id, saved.id)).get()!.workId,
    "work-target",
  );
  // A row whose file is gone is downloaded again instead of being reported as saved.
  const row = db.select().from(ebookEditions).where(eq(ebookEditions.id, saved.id)).get()!;
  unlinkSync(row.source);
  const downloads = mirror(epub, () => epub);
  await saveEbook(libgen(epub, "work-target"));
  assert.equal(downloads(), 1);
  assert.ok(existsSync(row.source));
});
test("r4#4: a slow but steady ebook body isn't cut off; a stalled one fails with a clear error", async () => {
  const previous = { ...ebookTimeouts };
  Object.assign(ebookTimeouts, { response: 200, idle: 200 });
  try {
    const epub = Buffer.from(`PK\x03\x04 slow mirror ${sequence++}`.padEnd(64, "."));
    // About 600 ms in total, well past the response timeout, with a chunk every 40 ms.
    mirror(epub, () => {
      let offset = 0;
      return new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          if (offset >= epub.length) return controller.close();
          controller.enqueue(epub.subarray(offset, offset + 4));
          offset += 4;
        },
      });
    });
    const saved = await saveEbook(libgen(epub));
    assert.ok(db.select().from(ebookEditions).where(eq(ebookEditions.id, saved.id)).get());

    const stalled = Buffer.from(`PK\x03\x04 stalled mirror ${sequence++}`);
    mirror(stalled, (signal) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(stalled.subarray(0, 4));
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      }),
    );
    await assert.rejects(saveEbook(libgen(stalled)), /stalled/);
    assert.ok(
      !readdirSync(join(temp, "media", "ebooks")).some((name) => name.endsWith(".part")),
    );
  } finally {
    Object.assign(ebookTimeouts, previous);
  }
});
test("r4#5 (guard, not a bug): concurrent identical uploads create one work", async () => {
  const pdf = Buffer.from(`%PDF-1.4\n% concurrent ${sequence++}\n%%EOF\n`);
  const count = db.select().from(works).all().length;
  const [first, second] = await Promise.all([
    upload("Twice.pdf", pdf),
    upload("Twice.pdf", pdf),
  ]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(db.select().from(works).all().length, count + 1);
});
const { publicFetch, privateAddress } = await import("../server/ebooks.ts");
const { mock } = await import("node:test");
const dns = (await import("node:dns")).default;
test("r4#2: private IPv4 and IPv6 ranges are refused, public addresses are not", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "::1",
    "::",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fdff::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "ff02::1",
  ])
    assert.equal(privateAddress(ip), true, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(privateAddress(ip), false, ip);
  assert.equal(privateAddress("not an address"), true);
});
test("r4#2: the address checked is the address connected to, even when DNS changes its answer", async () => {
  // The first answer is public; the one used to connect points at loopback.
  const lookup = mock.method(dns, "lookup", (_host: string, options: any, callback: any) => {
    const address = { address: "127.0.0.1", family: 4 };
    if (options?.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  });
  const promises = mock.method(dns.promises, "lookup", async () => [
    { address: "1.1.1.1", family: 4 },
  ]);
  try {
    await assert.rejects(publicFetch("https://rebind.example/file"), /private network/);
    assert.ok(lookup.mock.callCount() >= 1);
  } finally {
    lookup.mock.restore();
    promises.mock.restore();
  }
  for (const literal of ["https://[fe90::1]/x", "https://[64:ff9b::7f00:1]/x", "https://[::ffff:7f00:1]/x"])
    await assert.rejects(publicFetch(literal), /private network/, literal);
});
test("r4#2: mirror pages don't follow redirects to private addresses", async () => {
  const requested: { url: string; redirect?: RequestRedirect }[] = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ url: String(input), redirect: init?.redirect });
    return new Response(null, {
      status: 302,
      headers: { Location: "https://127.0.0.1:443/admin" },
    });
  };
  const epub = Buffer.from(`PK\x03\x04 redirect ${sequence++}`);
  await assert.rejects(saveEbook(libgen(epub)));
  assert.ok(requested.length >= 1);
  assert.ok(requested.every((request) => request.redirect === "manual"));
  assert.ok(!requested.some((request) => request.url.includes("127.0.0.1")));
});
