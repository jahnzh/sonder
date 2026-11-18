// The shell's upload module (#605, src/device-import.ts) and the import row's lines, as functions with plain data:
// what is sent and in what order, what the row shows while it runs, a second import waiting, the end closing a
// watching sheet or showing the toast, a refusal in the row or in the toast.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDeviceImports,
  importRow,
  importedToast,
  inNameOrder,
  type Send,
} from "../src/device-import.ts";
import { deviceImportLine } from "../src/status-lines.ts";

type Call = { url: string; form: FormData; onProgress: (fraction: number) => void; resolve: (value?: unknown) => void; reject: (error: Error) => void };
function harness() {
  const calls: Call[] = [];
  const send: Send = ({ url, form, onProgress }) =>
    new Promise((resolve, reject) => calls.push({ url, form, onProgress, resolve, reject }));
  const imports = createDeviceImports(send);
  const toasts: { text: string; error: boolean }[] = [];
  let refreshed = 0;
  imports.configure({
    refresh: () => {
      refreshed++;
    },
    notify: (text, error = false) => toasts.push({ text, error }),
  });
  return { imports, calls, toasts, refreshed: () => refreshed };
}
const file = (name: string, type = "audio/mpeg") => new File([new Uint8Array([1, 2, 3])], name, { type });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("audio files are sent in name order to POST /api/import with the book's workId before them", () => {
  const { imports, calls } = harness();
  assert.equal(imports.start("audiobook", "w-1", "Dune", [file("10 Ten.mp3"), file("2 Two.mp3"), file("1 One.mp3")]), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/import");
  const entries = [...calls[0].form.entries()];
  assert.deepEqual(entries.map(([key]) => key), ["workId", "files", "files", "files"]);
  assert.equal(entries[0][1], "w-1");
  assert.deepEqual(entries.slice(1).map(([, value]) => (value as File).name), ["1 One.mp3", "2 Two.mp3", "10 Ten.mp3"]);
  // No title or author: the book gives them.
  assert.equal(calls[0].form.has("title"), false);
  assert.equal(calls[0].form.has("author"), false);
});

test("an ebook is sent alone to POST /api/ebooks/import?workId=", () => {
  const { imports, calls } = harness();
  imports.start("ebook", "w/2", "Emma", [file("emma.epub", "application/epub+zip")]);
  assert.equal(calls[0].url, "/api/ebooks/import?workId=w%2F2");
  assert.deepEqual([...calls[0].form.keys()], ["file"]);
});

test("while it runs the row is a File row: Uploading · 43%, then Preparing the audio… or Importing…", () => {
  const { imports, calls } = harness();
  imports.start("audiobook", "w-1", "Dune", [file("a.mp3")]);
  assert.deepEqual(importRow(imports.get(), "audiobook", "w-1"), { state: "running", phase: "uploading", progress: 0 });
  calls[0].onProgress(0.43);
  const row = importRow(imports.get(), "audiobook", "w-1");
  assert.deepEqual(row, { state: "running", phase: "uploading", progress: 0.43 });
  assert.equal(deviceImportLine({ kind: "audiobook", phase: "uploading", progress: 0.43 }), "Uploading · 43%");
  calls[0].onProgress(1);
  assert.deepEqual(importRow(imports.get(), "audiobook", "w-1"), { state: "running", phase: "processing", progress: 1 });
  assert.equal(deviceImportLine({ kind: "audiobook", phase: "processing", progress: 1 }), "Preparing the audio…");
  assert.equal(deviceImportLine({ kind: "ebook", phase: "processing", progress: 1 }), "Importing…");
  assert.equal(deviceImportLine({ kind: "ebook", phase: "uploading", progress: 0.999 }), "Uploading · 100%");
});

test("a second import waits until the first ends: its row is off and nothing is sent", async () => {
  const { imports, calls } = harness();
  imports.start("audiobook", "w-1", "Dune", [file("a.mp3")]);
  // The other sheet of the same book, and another book's sheets: off.
  assert.deepEqual(importRow(imports.get(), "ebook", "w-1"), { state: "waiting" });
  assert.deepEqual(importRow(imports.get(), "audiobook", "w-2"), { state: "waiting" });
  assert.equal(imports.busy(), true);
  assert.equal(imports.start("ebook", "w-2", "Emma", [file("e.epub")]), false);
  assert.equal(imports.start("audiobook", "w-1", "Dune", [file("b.mp3")]), false);
  assert.equal(calls.length, 1);
  calls[0].resolve({ id: "x" });
  await settle();
  assert.equal(imports.busy(), false);
  assert.deepEqual(importRow(imports.get(), "audiobook", "w-2"), { state: "ready" });
  assert.equal(imports.start("ebook", "w-2", "Emma", [file("e.epub")]), true);
  assert.equal(calls.length, 2);
});

test("with the sheet open the end reads the library again and closes the sheet; no toast", async () => {
  const { imports, calls, toasts, refreshed } = harness();
  let closed = 0;
  const unwatch = imports.watch("audiobook", "w-1", () => closed++);
  imports.start("audiobook", "w-1", "Dune", [file("a.mp3")]);
  calls[0].resolve({ id: "x" });
  await settle();
  assert.equal(refreshed(), 1);
  assert.equal(closed, 1);
  assert.deepEqual(toasts, []);
  assert.equal(imports.get(), null);
  unwatch();
});

test("with the sheet closed meanwhile the upload goes on and its end is the toast", async () => {
  const { imports, calls, toasts, refreshed } = harness();
  let closed = 0;
  const unwatch = imports.watch("audiobook", "w-1", () => closed++);
  imports.start("audiobook", "w-1", "Dune", [file("a.mp3")]);
  calls[0].onProgress(0.5);
  unwatch();
  // Closing the sheet does not stop the upload.
  assert.equal(imports.busy(), true);
  calls[0].resolve({ id: "x" });
  await settle();
  assert.equal(closed, 0);
  assert.equal(refreshed(), 1);
  assert.deepEqual(toasts, [{ text: "Dune: audio files imported.", error: false }]);
  assert.equal(importedToast("ebook", "Emma"), "Emma: ebook imported.");
});

test("a sheet for another book does not take the end of this book's upload", async () => {
  const { imports, calls, toasts } = harness();
  let closed = 0;
  imports.watch("audiobook", "w-2", () => closed++);
  imports.watch("ebook", "w-1", () => closed++);
  imports.start("audiobook", "w-1", "Dune", [file("a.mp3")]);
  calls[0].resolve({});
  await settle();
  assert.equal(closed, 0);
  assert.deepEqual(toasts, [{ text: "Dune: audio files imported.", error: false }]);
});

test("a refusal with the sheet open stands in the row, and the row can be tapped again", async () => {
  const { imports, calls, toasts } = harness();
  let closed = 0;
  const unwatch = imports.watch("audiobook", "w-1", () => closed++);
  imports.start("audiobook", "w-1", "Dune", [file("notes.txt", "text/plain")]);
  calls[0].reject(new Error("Choose MP3, M4B, M4A, OGG, Opus, FLAC, or WAV audio files."));
  await settle();
  assert.equal(closed, 0);
  assert.deepEqual(toasts, []);
  assert.deepEqual(importRow(imports.get(), "audiobook", "w-1"), { state: "failed", error: "Choose MP3, M4B, M4A, OGG, Opus, FLAC, or WAV audio files." });
  // Another book's rows are not off for it.
  assert.deepEqual(importRow(imports.get(), "audiobook", "w-2"), { state: "ready" });
  assert.equal(imports.busy(), false);
  assert.equal(imports.start("audiobook", "w-1", "Dune", [file("a.mp3")]), true);
  assert.deepEqual(importRow(imports.get(), "audiobook", "w-1"), { state: "running", phase: "uploading", progress: 0 });
  unwatch();
});

test("a refusal with the sheet closed is the toast in the failed colour; a refusal with no sentence gets one", async () => {
  const { imports, calls, toasts } = harness();
  imports.start("ebook", "w-1", "Emma", [file("e.epub")]);
  calls[0].reject(new Error(""));
  await settle();
  assert.deepEqual(toasts, [{ text: "This ebook could not be imported.", error: true }]);
  assert.equal(imports.get(), null);
});

test("closing the sheet takes its refusal with it", async () => {
  const { imports, calls } = harness();
  const unwatch = imports.watch("audiobook", "w-1", () => {});
  imports.start("audiobook", "w-1", "Dune", [file("a.mp3")]);
  calls[0].reject(new Error("This file exceeds the 4 GB upload limit."));
  await settle();
  assert.equal(importRow(imports.get(), "audiobook", "w-1").state, "failed");
  unwatch();
  assert.equal(imports.get(), null);
});

test("no files chosen starts nothing; the name order counts numbers as numbers", () => {
  const { imports, calls } = harness();
  assert.equal(imports.start("audiobook", "w-1", "Dune", []), false);
  assert.equal(calls.length, 0);
  assert.deepEqual(inNameOrder([{ name: "Part 10" }, { name: "Part 9" }, { name: "Part 1" }]).map((f) => f.name), ["Part 1", "Part 9", "Part 10"]);
});
