// The thread that prepares one book's text (#827). Preparing parses, places and writes a whole chapter in one go and
// then packs the whole book, which holds a thread for up to a second at a time on a large book; on the server's own
// thread nothing is answered meanwhile, audio included. So server/prepared-text-cache.ts starts this file as a
// worker thread for each book: it is given the book's sentences (extractBook's, cut on the main thread), reads the
// EPUB, and writes the prepared folder's files into the temp folder it is told. It opens no database.
import { parentPort, workerData } from "node:worker_threads";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PREPARED_TEXT_VERSION, prepareEpub, type PreparedBookInput } from "./prepared-text.ts";

export type PrepareJob = {
  /** The EPUB file, the temp folder to write into, and the address the output will be served under. */
  source: string;
  temp: string;
  base: string;
  key: string;
  book: Omit<PreparedBookInput, "sections">;
};
/** The book's sentences arrive in pieces, so that sending them never holds the server's thread for long. */
export type PrepareMessage =
  | { type: "sentences"; section: Omit<PreparedBookInput["sections"][number], "paragraphs">; paragraphs: PreparedBookInput["sections"][number]["paragraphs"] }
  | { type: "run" };
export type PrepareAnswer = { ok: true; bytes: number } | { ok: false; message: string };

const job = workerData as PrepareJob;
const sections: PreparedBookInput["sections"] = [];
async function run(): Promise<PrepareAnswer> {
  await mkdir(join(job.temp, "pictures"), { recursive: true, mode: 0o750 });
  let bytes = 0;
  const { manifest, parts } = await prepareEpub({
    epub: await readFile(job.source),
    book: { ...job.book, sections },
    key: job.key,
    base: job.base,
    writePicture: async (name, data) => {
      bytes += data.length;
      await writeFile(join(job.temp, "pictures", name), data);
    },
  });
  for (const [index, html] of parts.entries()) {
    bytes += Buffer.byteLength(html);
    await writeFile(join(job.temp, `p${index}.html`), html);
  }
  const text = JSON.stringify(manifest);
  await writeFile(join(job.temp, "manifest.json"), text);
  bytes += Buffer.byteLength(text);
  await writeFile(join(job.temp, "entry.json"), JSON.stringify({ id: job.book.id, key: job.key, version: PREPARED_TEXT_VERSION, bytes, preparedAt: Date.now() }));
  return { ok: true, bytes };
}
parentPort!.on("message", (message: PrepareMessage) => {
  if (message.type === "sentences") {
    const last = sections[sections.length - 1];
    if (last?.index === message.section.index) last.paragraphs.push(...message.paragraphs);
    else sections.push({ ...message.section, paragraphs: message.paragraphs });
    return;
  }
  // What goes wrong with a book is said to its reader in the error's own words, as on the main thread.
  run().then(
    (answer) => parentPort!.postMessage(answer),
    (error) => parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) } satisfies PrepareAnswer),
  );
});
