// Isolated app and synthetic files for the manual verifier test and its server-contract test.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import JSZip from "jszip";
import { tempDir } from "../temp-dir.ts";

export const repository = resolve(import.meta.dirname, "../..");
export const temp = tempDir("sonder-reading-sync-verifier-");
// The app resolves dist and its optional demo files from cwd. Only the built client is linked here;
// this avoids reading the repository's .env or its demo media, even on the production machine.
symlinkSync(join(repository, "dist"), join(temp, "dist"), "dir");
process.chdir(temp);
process.env.DATA_DIR = join(temp, "db");
process.env.MEDIA_ROOT = join(temp, "media");
process.env.REQUIRE_MEDIA_MOUNT = "false";
process.env.NODE_ENV = "test";
process.env.APP_PASSWORD = "synthetic-fixture-password";
delete process.env.TRANSMISSION_RPC_URL;
delete process.env.ALIGNMENT_WORKER_URL;
delete process.env.ALIGNMENT_WORKER_TOKEN;

const { installAlignmentFixture } = await import("../alignment-browser-fixture.ts");
await installAlignmentFixture(); // in-process worker and local staging; no SSH to pool hosts
const { db, sqlite } = await import("../../server/db.ts");
const schema = await import("../../server/schema.ts");
const { extractBook } = await import("../../server/reader.ts");
const { audioFingerprint } = await import("../../server/alignment.ts");
const { createApp } = await import("../../server/app.ts");
const { BOOK_ENGINE } = await import("../../src/reading-types.ts");

/** Silent PCM WAV: synthetic bytes, long enough for all three positions. */
function silentWav(seconds: number) {
  const sampleRate = 16000, dataBytes = sampleRate * 2 * seconds;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

async function syntheticEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const chapters = [0, 1, 2, 3, 4];
  zip.file("OEBPS/content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">synthetic-verification</dc:identifier><dc:title>Synthetic Book</dc:title><dc:creator>Fixture Author</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((i) => `<itemref idref="s${i}"/>`).join("")}</spine></package>`);
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((i) => `<li><a href="s${i}.xhtml">Chapter ${i}</a></li>`).join("")}</ol></nav></body></html>`);
  for (const i of chapters) {
    const sentence = `In synthetic chapter ${i} a quiet traveller walked carefully beside the river while the evening lanterns shone brightly through the trees`;
    zip.file(`OEBPS/s${i}.xhtml`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i}</title></head><body><h1>Chapter ${i}</h1><p>${sentence}.</p></body></html>`);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

mkdirSync(join(temp, "media", "ebooks"), { recursive: true });
const epubFile = join(temp, "media", "ebooks", "synthetic.epub");
writeFileSync(epubFile, await syntheticEpub());
const audioFile = join(temp, "media", "synthetic.wav");
writeFileSync(audioFile, silentWav(110));
const now = Date.now();
db.insert(schema.works).values({ id: "synthetic-work", title: "Synthetic Book", author: "Fixture Author", description: "", genre: "", year: 2026 }).run();
db.insert(schema.editions).values({ id: "synthetic-edition", workId: "synthetic-work", cover: "", narrator: "Fixture Narrator", rating: 0, sourceLabel: "fixture", language: "en" }).run();
db.insert(schema.recordings).values({ id: "synthetic-recording", editionId: "synthetic-edition" }).run();
for (const index of [0, 1]) db.insert(schema.tracks).values({ id: `synthetic-track-${index}`, recordingId: "synthetic-recording", title: `Track ${index}`, index, duration: 110, chapters: [], source: audioFile, sourceType: "local" }).run();
db.insert(schema.ebookEditions).values({ id: "synthetic-ebook", workId: "synthetic-work", format: "epub", source: epubFile }).run();
db.insert(schema.userLibrary).values({ userId: 1, bookId: "synthetic-edition", status: "listening", addedAt: now }).run();
db.insert(schema.userProgress).values({ userId: 1, recordingId: "synthetic-recording", trackId: "synthetic-track-0", position: 3, duration: 110, updatedAt: now }).run();
export const manifest = await extractBook("synthetic-ebook");
assert.equal(manifest.sections.length, 5);
const flat = manifest.sections.flatMap((section) => section.paragraphs);
export const mapped = [0, 2, 4].map((index) => {
  const section = manifest.sections[index];
  const paragraph = section.paragraphs.find((item) => item.text.startsWith(`In synthetic chapter ${index}`));
  assert.ok(paragraph && paragraph.text.length >= 80 && paragraph.text.length < 300);
  const flatIndex = flat.findIndex((item) => item.id === paragraph.id);
  // The fixture worker's /anchor returns fragment i at 5 + i * 8 seconds.
  const start = 6 + flatIndex * 8;
  return { section: index, paragraphId: paragraph.id, trackId: index === 0 ? "synthetic-track-0" : "synthetic-track-1", start, end: start + 8, confidence: 0.9 };
});
export const checkpoint = { locator: { section: 0, paragraphId: manifest.sections[0].paragraphs[0].id, progression: 0 }, revision: 7, updatedAt: now, eventId: "fixture-event", deviceId: "fixture-device", origin: "reading" };
sqlite.prepare("INSERT INTO user_reader_checkpoints(user_id,edition_id,data) VALUES(1,?,?)").run("synthetic-ebook", JSON.stringify(checkpoint));
export const app = await createApp({ logger: false, background: { manual: true } });
export const job = {
  id: "synthetic-job", ebookId: "synthetic-ebook", recordingId: "synthetic-recording", status: "partial", progress: 1,
  engine: BOOK_ENGINE, outcome: "partial", mode: "anchored", error: null, warning: null,
  intervals: mapped, sectionsDone: [0, 2, 4], elapsedSeconds: 12, fingerprint: manifest.fingerprint,
  audioFingerprint: audioFingerprint("synthetic-recording"), createdAt: now, updatedAt: now, coverage: 0.61,
  unsyncedPassages: [1, 3].map((index) => ({ section: index, title: `Chapter ${index}`, firstParagraphId: "unused", lastParagraphId: "unused", sentenceCount: 1, excerpt: `Unmatched chapter ${index}` })),
  // Deliberately no pairings property.
};
export const saveJob = (data: object) => sqlite.prepare("INSERT INTO alignment_jobs(id,ebook_id,recording_id,data,updated_at,engine,outcome) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,engine=excluded.engine,outcome=excluded.outcome")
  .run(job.id, job.ebookId, job.recordingId, JSON.stringify(data), now, job.engine, job.outcome);
saveJob(job);
export const url = await app.listen({ host: "127.0.0.1", port: 0 });
assert.equal(new URL(url).hostname, "127.0.0.1");
assert.notEqual(new URL(url).port, "3001");


export const closeFixture = async () => { await app.close(); sqlite.close(); };
export { sqlite };
