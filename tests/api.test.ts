import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const temp = mkdtempSync(join(tmpdir(), "sonder-test-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
delete process.env.APP_PASSWORD;
const { createApp, listBooks } = await import("../server/app.ts");
const { db, sqlite } = await import("../server/db.ts");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { encrypt } = await import("../server/security.ts");
const { acquire, refreshAcquisition, magnetHash, chooseBackend, isHashCached } =
  await import("../server/acquisitions.ts");
const app = await createApp();
after(async () => {
  await app.close();
  sqlite.close();
  rmSync(temp, { recursive: true, force: true });
});
function wave() {
  const n = 8000,
    b = Buffer.alloc(44 + n * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.round(Math.sin((i * 440 * Math.PI * 2) / 8000) * 2000),
      44 + i * 2,
    );
  return b;
}
test("catalog preserves distinct work, edition and recording IDs and never exposes media sources", async () => {
  const res = await app.inject("/api/books");
  assert.equal(res.statusCode, 200);
  const books = res.json();
  assert.equal(books.length, 8);
  assert.equal(
    books.filter((b: { inLibrary: boolean }) => b.inLibrary).length,
    6,
  );
  const alice = books.find((b: { id: string }) => b.id === "alice");
  assert.equal(alice.tracks.length, 12);
  assert.notEqual(alice.workId, alice.recordingId);
  assert.equal(alice.tracks[0].source, "");
});
test("local playback supports HEAD, byte ranges and 416 responses", async () => {
  const full = await app.inject("/api/media/alice-0");
  assert.equal(full.statusCode, 200);
  const partial = await app.inject({
    url: "/api/media/alice-0",
    headers: { range: "bytes=100-199" },
  });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.rawPayload.length, 100);
  assert.deepEqual(partial.rawPayload, full.rawPayload.subarray(100, 200));
  const suffix = await app.inject({
    url: "/api/media/alice-0",
    headers: { range: "bytes=-20" },
  });
  assert.deepEqual(suffix.rawPayload, full.rawPayload.subarray(-20));
  const head = await app.inject({
    method: "HEAD",
    url: "/api/media/alice-0",
    headers: { range: "bytes=0-1" },
  });
  assert.equal(head.statusCode, 206);
  assert.equal(head.rawPayload.length, 0);
  assert.equal(head.headers["content-length"], "2");
  assert.equal(
    (
      await app.inject({
        url: "/api/media/alice-0",
        headers: { range: "bytes=999999999-" },
      })
    ).statusCode,
    416,
  );
});
test("progress rejects recording mismatches and preserves newer cross-device progress", async () => {
  const p = {
    recordingId: "recording-alice",
    trackId: "alice-0",
    position: 25,
    duration: 640,
    updatedAt: Date.now(),
  };
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/progress", payload: p }))
      .statusCode,
    200,
  );
  const stale = await app.inject({
    method: "POST",
    url: "/api/progress",
    payload: { ...p, position: 2, updatedAt: p.updatedAt - 100 },
  });
  assert.equal(stale.json().conflict, true);
  assert.equal(stale.json().progress.position, 25);
  const bad = await app.inject({
    method: "POST",
    url: "/api/progress",
    payload: { ...p, trackId: "sherlock-0" },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/progress",
        payload: { ...p, position: -2 },
      })
    ).statusCode,
    400,
  );
});
test("secrets are encrypted and do not appear in settings responses", async () => {
  const key = "test-secret-not-a-real-key";
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        // "annas" is still sent by older clients and must be ignored.
        payload: { torbox: key, annas: key },
      })
    ).statusCode,
    200,
  );
  const stored = db
    .select()
    .from(s.settings)
    .where(eq(s.settings.key, "torbox"))
    .get();
  assert.ok(stored && !stored.value.includes(key));
  const settings = (await app.inject("/api/settings")).json();
  assert.equal(settings.torboxConfigured, true);
  assert.equal(settings.annasConfigured, undefined);
  assert.equal(
    db.select().from(s.settings).where(eq(s.settings.key, "annas")).get(),
    undefined,
  );
  assert.ok(!JSON.stringify(settings).includes(key));
  db.delete(s.settings).where(eq(s.settings.key, "torbox")).run();
});
test("cross-origin mutations and invalid mirror URLs are rejected", async () => {
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/library",
        headers: { origin: "https://evil.example" },
        payload: { bookId: "gatsby" },
      })
    ).statusCode,
    403,
  );
  for (const payload of [
    { abbUrl: "https://127.0.0.1" },
    { libgenUrl: "http://libgen.li" },
  ])
    assert.equal(
      (await app.inject({ method: "PATCH", url: "/api/settings", payload }))
        .statusCode,
      400,
    );
});
test("single-user sessions require a valid password, use HTTP-only cookies, and revoke on logout", async () => {
  process.env.APP_PASSWORD = "test-passphrase";
  try {
    assert.equal((await app.inject("/api/books")).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { password: "wrong" },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "test-passphrase" },
    });
    assert.equal(login.statusCode, 200);
    const setCookie = String(login.headers["set-cookie"]);
    assert.ok(/HttpOnly/i.test(setCookie));
    assert.ok(/SameSite=Strict/i.test(setCookie));
    const cookie = setCookie.split(";")[0];
    assert.equal(
      (await app.inject({ url: "/api/books", headers: { cookie } })).statusCode,
      200,
    );
    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    assert.equal(
      (await app.inject({ url: "/api/books", headers: { cookie } })).statusCode,
      401,
    );
  } finally {
    delete process.env.APP_PASSWORD;
  }
});
test("local audio imports persist files under MEDIA_ROOT and use real durations", async () => {
  const boundary = "sonder-import-test";
  const audio = wave();
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nMy test story\r\n--${boundary}\r\nContent-Disposition: form-data; name="author"\r\n\r\nTest author\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="chapter.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const result = await app.inject({
    method: "POST",
    url: "/api/import",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(result.statusCode, 200, result.body);
  const book = listBooks().find((b) => b.id === result.json().id)!;
  assert.equal(book.title, "My test story");
  assert.equal(book.author, "Test author");
  assert.equal(book.tracks[0].duration, 1);
  assert.equal(book.serverStored, true);
  const stored = db
    .select()
    .from(s.tracks)
    .where(eq(s.tracks.id, book.tracks[0].id))
    .get()!;
  assert.ok(stored.source.startsWith(join(temp, "media", "imports")));
  assert.ok(existsSync(stored.source));
});
test("routing selects TorBox only for an explicit cache hit and supports base32 magnets", async () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(magnetHash(`magnet:?xt=urn:btih:${hash.toUpperCase()}`), hash);
  assert.equal(
    magnetHash("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    "0".repeat(40),
  );
  assert.throws(() => magnetHash("magnet:?xt=urn:btih:wrong"));
  assert.equal(isHashCached([{ hash: hash.toUpperCase() }], hash), true);
  assert.equal(
    await chooseBackend(hash, true, async () => [{ hash }]),
    "torbox",
  );
  assert.equal(await chooseBackend(hash, true, async () => []), "local");
  assert.equal(
    await chooseBackend(hash, true, async () => {
      throw new Error("unavailable");
    }),
    "local",
  );
  assert.equal(
    await chooseBackend(hash, false, async () => {
      throw new Error("should not be called");
    }),
    "local",
  );
});
test("local fallback negotiates Transmission sessions, persists jobs, and rejects preallocated incomplete audio", async () => {
  const hash = "b".repeat(40),
    wav = wave();
  let completion = 0;
  let added = 0;
  let sessionNegotiated = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.headers["x-transmission-session-id"] !== "test-session") {
      sessionNegotiated = true;
      res.writeHead(409, { "X-Transmission-Session-Id": "test-session" }).end();
      return;
    }
    const body = JSON.parse(raw);
    let args: unknown = {};
    if (body.method === "session-get")
      args = {
        "download-dir": "/downloads/complete",
        "incomplete-dir": "/downloads/incomplete",
        "incomplete-dir-enabled": true,
      };
    if (body.method === "torrent-add") {
      added++;
      assert.equal(body.arguments["download-dir"], "/downloads/complete");
      args = {
        "torrent-added": { id: 1, hashString: hash, name: "Fixture story" },
      };
    }
    if (body.method === "torrent-get")
      args = {
        torrents: [
          {
            id: 1,
            hashString: hash,
            name: "Fixture story",
            downloadDir: "/downloads/complete",
            percentDone: completion === 2 ? 1 : 0.5,
            status: 4,
            error: 0,
            errorString: "",
            files: [
              {
                name: "fixture/chapter.wav",
                length: wav.length,
                bytesCompleted: completion === 2 ? wav.length : wav.length - 1,
              },
            ],
            fileStats: [{ wanted: true }],
          },
        ],
      };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ result: "success", arguments: args }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  process.env.TRANSMISSION_RPC_URL = `http://127.0.0.1:${address.port}/transmission/rpc`;
  try {
    mkdirSync(join(temp, "media", "complete", "fixture"), { recursive: true });
    writeFileSync(
      join(temp, "media", "complete", "fixture", "chapter.wav"),
      wav,
    );
    const job = await acquire(`magnet:?xt=urn:btih:${hash}&dn=Fixture+story`, {
      title: "Fixture story",
    });
    assert.equal(job.backend, "local");
    assert.equal(job.status, "downloading");
    assert.equal(job.bookId, null);
    assert.equal(sessionNegotiated, true);
    assert.equal(added, 1);
    const duplicate = await acquire(`magnet:?xt=urn:btih:${hash}`);
    assert.equal(duplicate.id, job.id);
    assert.equal(added, 1);
    completion = 1;
    await refreshAcquisition(job.id);
    assert.equal(
      db
        .select()
        .from(s.acquisitions)
        .where(eq(s.acquisitions.id, job.id))
        .get()!.bookId,
      null,
    );
    completion = 2;
    await refreshAcquisition(job.id);
    const ready = db
      .select()
      .from(s.acquisitions)
      .where(eq(s.acquisitions.id, job.id))
      .get()!;
    assert.equal(ready.status, "ready");
    const book = listBooks().find((b) => b.id === ready.bookId)!;
    assert.equal(book.serverStored, true);
    assert.equal(book.tracks[0].duration, 1);
    assert.equal(
      (await app.inject(`/api/media/${book.tracks[0].id}`)).statusCode,
      200,
    );
  } finally {
    delete process.env.TRANSMISSION_RPC_URL;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("r3: a completed torrent whose audio fails validation becomes a retryable error", async () => {
  const hash = "e".repeat(40);
  const broken = Buffer.alloc(4096, 7);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.headers["x-transmission-session-id"] !== "test-session") {
      res.writeHead(409, { "X-Transmission-Session-Id": "test-session" }).end();
      return;
    }
    const body = JSON.parse(raw);
    let args: unknown = {};
    if (body.method === "session-get")
      args = { "download-dir": "/downloads/complete" };
    if (body.method === "torrent-add")
      args = {
        "torrent-added": { id: 2, hashString: hash, name: "Broken story" },
      };
    if (body.method === "torrent-get")
      args = {
        torrents: [
          {
            id: 2,
            hashString: hash,
            name: "Broken story",
            downloadDir: "/downloads/complete",
            percentDone: 1,
            status: 6,
            error: 0,
            errorString: "",
            files: [
              {
                name: "broken/chapter.mp3",
                length: broken.length,
                bytesCompleted: broken.length,
              },
            ],
            fileStats: [{ wanted: true }],
          },
        ],
      };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ result: "success", arguments: args }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  process.env.TRANSMISSION_RPC_URL = `http://127.0.0.1:${address.port}/transmission/rpc`;
  try {
    mkdirSync(join(temp, "media", "complete", "broken"), { recursive: true });
    writeFileSync(
      join(temp, "media", "complete", "broken", "chapter.mp3"),
      broken,
    );
    const job = await acquire(`magnet:?xt=urn:btih:${hash}&dn=Broken+story`, {
      title: "Broken story",
    });
    assert.equal(job.backend, "local");
    await refreshAcquisition(job.id);
    const failed = db
      .select()
      .from(s.acquisitions)
      .where(eq(s.acquisitions.id, job.id))
      .get()!;
    assert.equal(failed.status, "error");
    assert.match(failed.error || "", /audio/);
    assert.equal(failed.bookId, null);
  } finally {
    delete process.env.TRANSMISSION_RPC_URL;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("cached TorBox acquisitions set add_only_if_cached and never start a local torrent", async () => {
  const original = globalThis.fetch;
  const hash = "c".repeat(40);
  let checked = false,
    created = false;
  db.insert(s.settings)
    .values({ key: "torbox", value: encrypt("fake-key") })
    .run();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    let data: unknown;
    if (url.includes("checkcached")) {
      checked = true;
      data = [{ hash }];
    } else if (url.includes("createtorrent")) {
      created = true;
      assert.equal((init!.body as FormData).get("add_only_if_cached"), "true");
      data = { torrent_id: 77 };
    } else if (url.includes("mylist"))
      data = {
        download_present: true,
        files: [{ id: 1, name: "Chapter 1.mp3" }],
      };
    else return original(input, init);
    return new Response(JSON.stringify({ success: true, data }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const job = await acquire(`magnet:?xt=urn:btih:${hash}`, {
      title: "A cached test story",
    });
    assert.equal(checked, true);
    assert.equal(created, true);
    assert.equal(job.backend, "torbox");
    assert.equal(job.status, "ready");
  } finally {
    globalThis.fetch = original;
    db.delete(s.settings).where(eq(s.settings.key, "torbox")).run();
  }
});
test("permanent stream copies reject interrupted files and preserve recording identity on retry", async () => {
  const { requestServerDownload } = await import("../server/downloads.ts");
  const original = globalThis.fetch;
  const wav = wave();
  const id = "copy-fixture";
  db.insert(s.works)
    .values({
      id: "work-copy-fixture",
      title: "A permanent copy",
      author: "Test author",
      description: "Test recording",
      genre: "Audiobook",
      year: 2026,
    })
    .run();
  db.insert(s.editions)
    .values({
      id,
      workId: "work-copy-fixture",
      cover: "/covers/time.svg",
      narrator: "Test reader",
      rating: 0,
      sourceLabel: "Test stream",
    })
    .run();
  db.insert(s.recordings)
    .values({ id: "recording-copy-fixture", editionId: id })
    .run();
  db.insert(s.tracks)
    .values({
      id: "copy-fixture-0",
      recordingId: "recording-copy-fixture",
      title: "A chapter",
      index: 0,
      duration: 1,
      source: "https://audio.example.test/fixture.wav",
      sourceType: "remote",
    })
    .run();
  let interrupted = true;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== "https://audio.example.test/fixture.wav")
      return original(input, init);
    const body = interrupted
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(wav.subarray(0, 50));
            controller.error(new Error("Simulated connection loss"));
          },
        })
      : wav;
    return new Response(body, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length),
      },
    });
  };
  const waitFor = async (status: string) => {
    for (let i = 0; i < 100; i++) {
      const row = db
        .select()
        .from(s.serverDownloads)
        .where(eq(s.serverDownloads.recordingId, "recording-copy-fixture"))
        .get();
      if (row?.status === status) return row;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Download did not reach " + status);
  };
  try {
    requestServerDownload(id);
    await waitFor("error");
    assert.equal(
      db
        .select()
        .from(s.mediaCopies)
        .where(eq(s.mediaCopies.trackId, "copy-fixture-0"))
        .get(),
      undefined,
    );
    interrupted = false;
    requestServerDownload(id);
    await waitFor("ready");
    const book = listBooks().find((b) => b.id === id)!;
    assert.equal(book.recordingId, "recording-copy-fixture");
    assert.equal(book.serverStored, true);
    const stored = db
      .select()
      .from(s.mediaCopies)
      .where(eq(s.mediaCopies.trackId, "copy-fixture-0"))
      .get()!;
    assert.ok(stored.path.startsWith(join(temp, "media", "saved")));
    assert.equal(stored.size, wav.length);
    assert.equal(
      (await app.inject("/api/media/copy-fixture-0")).rawPayload.length,
      wav.length,
    );
    assert.equal(
      db.select().from(s.tracks).where(eq(s.tracks.id, "copy-fixture-0")).get()!
        .sourceType,
      "remote",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("ebook saving verifies checksum, persists on the media drive, and links the ebook to a work", async () => {
  const { saveEbook, publicFetch } = await import("../server/ebooks.ts");
  const { createHash } = await import("node:crypto");
  const original = globalThis.fetch;
  const content = Buffer.from("PK\x03\x04epub test fixture");
  const md5 = createHash("md5").update(content).digest("hex");
  let bad = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/ads.php?"))
      return new Response(
        `<a href="https://1.1.1.1/get.php?md5=${md5}&amp;key=test">GET</a>`,
      );
    if (String(input).startsWith("https://1.1.1.1/"))
      return new Response(bad ? Buffer.from("bad checksum") : content, {
        headers: { "Content-Length": String(bad ? 12 : content.length) },
      });
    return original(input, init);
  };
  try {
    await assert.rejects(
      publicFetch("https://127.0.0.1/private"),
      /private network/,
    );
    await assert.rejects(
      publicFetch("http://example.com/file"),
      /secure public/,
    );
    const input = {
      md5,
      source: "libgen" as const,
      title: "Alice ebook",
      authors: ["Lewis Carroll"],
      extension: "epub",
      language: "English",
      size: "1 KB",
      year: "1865",
      coverUrl: null,
      url: "https://libgen.li/ads.php?md5=" + md5,
      workId: "work-alice",
    };
    const saved = await saveEbook(input);
    const row = db
      .select()
      .from(s.ebookEditions)
      .where(eq(s.ebookEditions.id, saved.id))
      .get()!;
    assert.equal(row.workId, "work-alice");
    assert.ok(row.source.startsWith(join(temp, "media", "ebooks")));
    assert.equal(
      (await app.inject(`/api/ebooks/${saved.id}/file`)).rawPayload.toString(),
      content.toString(),
    );
    bad = true;
    const other = { ...input, md5: "d".repeat(32) };
    await assert.rejects(saveEbook(other), /checksum/);
    assert.equal(
      db
        .select()
        .from(s.ebookEditions)
        .where(eq(s.ebookEditions.id, "libgen-" + other.md5))
        .get(),
      undefined,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("media guard refuses the wrong or missing volume marker before any media write", async () => {
  const { ensureMediaStorage, resolveTorrentFile } = await import(
    "../server/storage.ts"
  );
  const previous = process.env.REQUIRE_MEDIA_MOUNT;
  process.env.REQUIRE_MEDIA_MOUNT = "true";
  process.env.MEDIA_VOLUME_ID = "a-volume-that-is-not-mounted";
  try {
    assert.throws(
      () => ensureMediaStorage(),
      /configured media volume is unavailable/,
    );
  } finally {
    process.env.REQUIRE_MEDIA_MOUNT = previous;
    delete process.env.MEDIA_VOLUME_ID;
  }
  assert.throws(
    () => resolveTorrentFile("/downloads/complete", "../../outside.wav"),
    /unsafe media path/,
  );
  assert.throws(
    () => resolveTorrentFile("/downloads/other", "file.wav"),
    /outside Sonder/,
  );
});

test("import checks media storage before accepting uploads", async () => {
 process.env.REQUIRE_MEDIA_MOUNT="true"; process.env.MEDIA_VOLUME_ID="missing-volume";
 try { const r=await app.inject({method:"POST",url:"/api/import",headers:{"content-type":"multipart/form-data; boundary=x"},payload:"--x--\r\n"}); assert.equal(r.statusCode,400); assert.match(r.body,/media volume is unavailable/); }
 finally { process.env.REQUIRE_MEDIA_MOUNT="false"; delete process.env.MEDIA_VOLUME_ID; }
});

test("ebook download has a usable fallback and UTF-8 filename", async () => {
 const file=join(temp,"media","ebooks","filename.epub"); writeFileSync(file,"ebook");
 sqlite.prepare("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,?,?,?,?)").run("unicode-work","漢字","Author","","",2000);
 sqlite.prepare("INSERT INTO ebook_editions(id,work_id,format,source) VALUES(?,?,?,?)").run("unicode-book","unicode-work","epub",file);
 const r=await app.inject("/api/ebooks/unicode-book/file"); assert.equal(r.statusCode,200); assert.match(r.headers["content-disposition"] as string,/filename="ebook.epub"/); assert.match(r.headers["content-disposition"] as string,/filename\*=UTF-8''%E6%BC%A2%E5%AD%97.epub/);
});
