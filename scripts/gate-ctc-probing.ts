// Gate for #278: does CTC probing pick the same or a better edition than Whisper on a series?
//
//   tsx scripts/gate-ctc-probing.ts plan   <manifest.json> <workdir>
//   python worker/gate_whisper_probe.py --work <workdir> --media-root <media>      (Whisper arm, CPU)
//   ALIGNMENT_WORKER_TOKEN=... tsx scripts/gate-ctc-probing.ts ctc <manifest.json> <workdir> <worker-url> [titles]
//   tsx scripts/gate-ctc-probing.ts report <manifest.json> <workdir>               (exit 1 if CTC is worse)
//
// The manifest lists the titles (one audio file each, inside the CTC worker's MEDIA_ROOT) and the candidate
// EPUBs; every candidate is probed against every title, so a wrong edition has to be rejected, not just the
// right one found. Both arms use the production sample plan and the unchanged outlier rule. It runs on the
// host that holds the audio and a CTC worker started for it; it never touches the production database.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planSamples, wordCount, type AnchorFragment } from "../server/alignment-anchors.ts";
import { scoreCtcSamples, sampleFromWhisperAnchor, type AnchorSampleScore } from "../server/ebook-set-ctc-probe.ts";
import { gatePasses, judgeCandidate, pickedBook, renderTable, verdict, type TitleResult } from "./gate-ctc-probing-lib.ts";

type Manifest = {
  titles: { key: string; title: string; audio: string; duration: number; truth: string }[];
  /** `book` names the book a candidate holds when it is not its own key (a second copy of a volume). */
  candidates: { key: string; epub: string; book?: string }[];
};
type Passages = { key: string; passages: string[]; fragments: AnchorFragment[] };
type Plan = { title: string; audio: string; duration: number; samples: { trackId: string; time: number; duration: number }[] };

const [command, manifestPath, workdirArg, ...rest] = process.argv.slice(2);
if (!["plan", "ctc", "report"].includes(command) || !manifestPath || !workdirArg) {
  console.error("usage: gate-ctc-probing.ts plan|ctc|report <manifest.json> <workdir> [worker-url [titles]]");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const work = resolve(workdirArg);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

async function plan() {
  // Only the EPUB reader needs a database; give it a throwaway one.
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "gate-ctc-probing-"));
  process.env.MEDIA_ROOT ??= process.env.DATA_DIR;
  process.env.REQUIRE_MEDIA_MOUNT = "false";
  const { db } = await import("../server/db.ts");
  const schema = await import("../server/schema.ts");
  const { extractBook } = await import("../server/reader.ts");
  db.insert(schema.works).values({ id: "gate", title: "Gate", author: "Gate", description: "", genre: "", year: 2026 }).run();
  mkdirSync(join(work, "passages"), { recursive: true });
  mkdirSync(join(work, "samples"), { recursive: true });
  for (const candidate of manifest.candidates) {
    db.insert(schema.ebookEditions).values({ id: candidate.key, workId: "gate", format: "epub", source: resolve(candidate.epub) }).run();
    const book = await extractBook(candidate.key);
    const paragraphs = book.sections.flatMap((section) =>
      section.paragraphs.map((paragraph) => ({ text: paragraph.text, section: section.index, words: wordCount(paragraph.text) })),
    );
    write(join(work, "passages", `${candidate.key}.json`), {
      key: candidate.key,
      language: book.language,
      passages: paragraphs.map((paragraph) => paragraph.text),
      fragments: paragraphs.map((paragraph) => ({ words: paragraph.words, section: paragraph.section })),
    });
    console.log(`${candidate.key}: ${paragraphs.length} paragraphs, language ${book.language || "?"}`);
  }
  for (const title of manifest.titles) {
    const samples = planSamples([{ id: title.key, duration: title.duration }]);
    write(join(work, "samples", `${title.key}.json`), { title: title.key, audio: resolve(title.audio), duration: title.duration, samples });
    console.log(`${title.key}: ${samples.length} samples`);
  }
}

async function ctc() {
  const [workerUrl, only] = rest;
  const token = process.env.ALIGNMENT_WORKER_TOKEN;
  if (!workerUrl || !token) throw new Error("ctc needs a worker URL and ALIGNMENT_WORKER_TOKEN");
  const wanted = (only ?? "").split(",").filter(Boolean);
  mkdirSync(join(work, "ctc"), { recursive: true });
  for (const title of manifest.titles) {
    if (wanted.length && !wanted.includes(title.key)) continue;
    const out = join(work, "ctc", `${title.key}.json`);
    if (existsSync(out)) continue;
    const planned = json(join(work, "samples", `${title.key}.json`)) as Plan;
    const outputDir = join(resolve(workdirArg), "ctc-out", title.key);
    mkdirSync(outputDir, { recursive: true });
    const results: Record<string, { scores: AnchorSampleScore[]; seconds: number }> = {};
    for (const candidate of manifest.candidates) {
      const passages = json(join(work, "passages", `${candidate.key}.json`)) as Passages;
      const started = Date.now();
      // The same cache identity for every candidate of a title, as the server sends for one recording.
      const scores = await scoreCtcSamples(
        { workerUrl: workerUrl.replace(/\/$/, ""), token, outputDir, recordingId: `gate-${title.key}`, audioFingerprint: `gate-v1:${title.key}` },
        {
          fragmentTexts: passages.passages,
          language: "eng",
          windows: planned.samples.map((sample) => ({ trackId: sample.trackId, audio: planned.audio, time: sample.time, duration: sample.duration })),
        },
      );
      results[candidate.key] = { scores, seconds: (Date.now() - started) / 1000 };
      console.log(`${title.key} x ${candidate.key}: ${results[candidate.key].seconds.toFixed(1)} s`);
    }
    write(out, results);
  }
}

function report() {
  const titles: TitleResult[] = [];
  const timings: string[] = [];
  for (const title of manifest.titles) {
    const planned = json(join(work, "samples", `${title.key}.json`)) as Plan;
    const ctcResults = json(join(work, "ctc", `${title.key}.json`)) as Record<string, { scores: AnchorSampleScore[]; seconds: number }>;
    const whisperResults = json(join(work, "whisper", `${title.key}.json`)) as Record<string, { text?: string; start?: number; match?: { index: number; score: number } | null }[]>;
    const tracks = [{ id: title.key, duration: title.duration }];
    const entry: TitleResult = {
      title: title.title,
      truth: title.truth,
      books: Object.fromEntries(manifest.candidates.map((candidate) => [candidate.key, candidate.book ?? candidate.key])),
      whisper: [],
      ctc: [],
    };
    for (const candidate of manifest.candidates) {
      const passages = json(join(work, "passages", `${candidate.key}.json`)) as Passages;
      const whisperScores = whisperResults[candidate.key].map((result, i) => sampleFromWhisperAnchor(result, planned.samples[i].time));
      entry.whisper.push(judgeCandidate(candidate.key, planned.samples, whisperScores, passages.fragments, passages.passages, tracks));
      entry.ctc.push(judgeCandidate(candidate.key, planned.samples, ctcResults[candidate.key].scores, passages.fragments, passages.passages, tracks));
    }
    titles.push(entry);
    const seconds = manifest.candidates.map((candidate) => ctcResults[candidate.key].seconds);
    timings.push(`| ${title.title} | ${planned.samples.length} | ${seconds[0].toFixed(1)} | ${(seconds.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, seconds.length - 1)).toFixed(1)} |`);
  }
  const lines = [
    renderTable(titles),
    "",
    "CTC probing time per title (seconds; the first candidate pays the acoustic pass, later candidates read the cache):",
    "",
    "| Title | Samples | First candidate | Mean of the others |",
    "| --- | --- | --- | --- |",
    ...timings,
  ];
  const passed = gatePasses(titles);
  lines.push("", passed ? "GATE PASSED: CTC picks the same or a clearly better edition for every title." : "GATE FAILED: CTC is worse for at least one title.");
  console.log(lines.join("\n"));
  write(join(work, "report.json"), { passed, titles: titles.map((entry) => ({ ...entry, whisperPick: pickedBook(entry, entry.whisper), ctcPick: pickedBook(entry, entry.ctc), verdict: verdict(entry.truth, pickedBook(entry, entry.whisper), pickedBook(entry, entry.ctc)) })) });
  writeFileSync(join(work, "report.md"), lines.join("\n") + "\n");
  if (!passed) process.exitCode = 1;
}

if (command === "plan") await plan();
else if (command === "ctc") await ctc();
else report();
