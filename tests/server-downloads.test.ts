import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "sonder-server-downloads-"));
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.SONDER_DOWNLOAD_RETRY_MS = "1,1,1";
const { db, sqlite } = await import("../server/db.ts");
const { readFileSync } = await import("node:fs");
const s = await import("../server/schema.ts");
const { eq } = await import("drizzle-orm");
const { processServerDownloads, pauseServerDownload } = await import(
  "../server/downloads.ts"
);
const original = globalThis.fetch;
after(() => {
  globalThis.fetch = original;
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
  return b;
}
function book(name: string) {
  db.insert(s.works)
    .values({
      id: `work-${name}`,
      title: name,
      author: "Test author",
      description: "",
      genre: "Audiobook",
      year: 2026,
    })
    .run();
  db.insert(s.editions)
    .values({
      id: `book-${name}`,
      workId: `work-${name}`,
      cover: "/covers/time.svg",
      narrator: "Test reader",
      rating: 0,
      sourceLabel: "Test stream",
    })
    .run();
  db.insert(s.recordings)
    .values({ id: `recording-${name}`, editionId: `book-${name}` })
    .run();
  db.insert(s.tracks)
    .values({
      id: `track-${name}`,
      recordingId: `recording-${name}`,
      title: "A chapter",
      index: 0,
      duration: 1,
      source: `https://audio.example.test/${name}.wav`,
      sourceType: "remote",
    })
    .run();
  db.insert(s.serverDownloads)
    .values({
      recordingId: `recording-${name}`,
      bookId: `book-${name}`,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}
const job = (name: string) =>
  db
    .select()
    .from(s.serverDownloads)
    .where(eq(s.serverDownloads.recordingId, `recording-${name}`))
    .get();
const copy = (name: string) =>
  db
    .select()
    .from(s.mediaCopies)
    .where(eq(s.mediaCopies.trackId, `track-${name}`))
    .get();

test("r2#3: jobs paused or removed while an earlier job in the batch runs are not downloaded", async () => {
  book("first");
  book("paused");
  book("removed");
  const wav = wave();
  const requested: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/first.wav")) {
      started();
      await gate;
    }
    return new Response(wav, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length),
      },
    });
  };
  const batch = processServerDownloads();
  await firstStarted;
  pauseServerDownload("recording-paused");
  db.delete(s.serverDownloads)
    .where(eq(s.serverDownloads.recordingId, "recording-removed"))
    .run();
  release();
  await batch;
  assert.equal(job("first")?.status, "ready");
  assert.ok(copy("first"));
  assert.equal(job("paused")?.status, "paused");
  assert.equal(copy("paused"), undefined);
  assert.equal(job("removed"), undefined);
  assert.equal(copy("removed"), undefined);
  assert.deepEqual(requested, ["https://audio.example.test/first.wav"]);
});

test("a file the source refuses once is retried and saved without a manual retry", async () => {
  book("flaky");
  const wav = wave();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("Bad Request", { status: 400 });
    return new Response(wav, {
      headers: { "Content-Type": "audio/wav", "Content-Length": String(wav.length) },
    });
  };
  await processServerDownloads();
  assert.equal(calls, 2);
  assert.equal(job("flaky")?.status, "ready");
  assert.ok(copy("flaky"));
});

test("a file the source keeps refusing fails after the last attempt", async () => {
  book("broken");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("Bad Request", { status: 400 });
  };
  await processServerDownloads();
  assert.equal(calls, 4);
  assert.equal(job("broken")?.status, "error");
  assert.match(job("broken")?.error || "", /could not be downloaded/);
  assert.equal(copy("broken"), undefined);
});

function cutOff(bytes: Buffer, keep: number) {
  return new Response(
    new ReadableStream({
      sent: false,
      pull(controller) {
        if (this.sent) return controller.error(new Error("connection reset"));
        this.sent = true;
        controller.enqueue(bytes.subarray(0, keep));
      },
    } as UnderlyingDefaultSource<Uint8Array> & { sent: boolean }),
    {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.length),
      },
    },
  );
}

test("a file cut off part-way continues from the bytes already saved", async () => {
  book("resumed");
  const wav = wave();
  const ranges: (string | null)[] = [];
  globalThis.fetch = async (_input, init) => {
    const range = new Headers(init?.headers).get("range");
    ranges.push(range);
    if (!range) return cutOff(wav, 5000);
    const from = Number(/bytes=(\d+)-/.exec(range)![1]);
    return new Response(wav.subarray(from), {
      status: 206,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wav.length - from),
        "Content-Range": `bytes ${from}-${wav.length - 1}/${wav.length}`,
      },
    });
  };
  await processServerDownloads();
  assert.deepEqual(ranges, [null, "bytes=5000-"]);
  assert.equal(job("resumed")?.status, "ready");
  assert.ok(readFileSync(copy("resumed")!.path).equals(wav));
});

test("a source that ignores the range restarts the file from the beginning", async () => {
  book("restarted");
  const wav = wave();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return cutOff(wav, 5000);
    return new Response(wav, {
      headers: { "Content-Type": "audio/wav", "Content-Length": String(wav.length) },
    });
  };
  await processServerDownloads();
  assert.equal(job("restarted")?.status, "ready");
  assert.ok(readFileSync(copy("restarted")!.path).equals(wav));
});

test("several files of one book are copied at the same time, in chapter order", async () => {
  book("parallel");
  for (let i = 1; i < 5; i++)
    db.insert(s.tracks)
      .values({
        id: `track-parallel-${i}`,
        recordingId: "recording-parallel",
        title: `Chapter ${i}`,
        index: i,
        duration: 1,
        source: `https://audio.example.test/parallel-${i}.wav`,
        sourceType: "remote",
      })
      .run();
  const wav = wave();
  const started: string[] = [];
  let inFlight = 0,
    most = 0;
  globalThis.fetch = async (input) => {
    started.push(String(input).split("/").pop()!);
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return new Response(wav, {
      headers: { "Content-Type": "audio/wav", "Content-Length": String(wav.length) },
    });
  };
  await processServerDownloads();
  assert.equal(job("parallel")?.status, "ready");
  assert.equal(most, 3);
  assert.deepEqual(started.slice(0, 3), [
    "parallel.wav",
    "parallel-1.wav",
    "parallel-2.wav",
  ]);
  assert.equal(
    db
      .select()
      .from(s.mediaCopies)
      .all()
      .filter((c) => c.trackId.startsWith("track-parallel")).length,
    5,
  );
});
