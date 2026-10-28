// Splits a plain-text chapter into the fragments Sonder would send to the
// worker: paragraphs, then Intl.Segmenter("en", { granularity: "sentence" }),
// trimmed (same call as server/reader.ts). Also writes word-level fragments for
// the AAS run: whitespace/dash-separated tokens that contain a letter or digit.
// Usage: node segment_sentences.mjs <chapter.txt> <out.json>
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: segment_sentences.mjs <chapter.txt> <out.json>");
const paragraphs = readFileSync(input, "utf8")
  .split(/\n\s*\n/)
  .map((p) => p.replace(/\s+/g, " ").trim())
  .filter(Boolean);
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const sentences = [];
paragraphs.forEach((paragraph, block) => {
  for (const s of segmenter.segment(paragraph)) {
    const text = s.segment.trim();
    if (text) sentences.push({ block, text });
  }
});
const words = sentences.flatMap((sentence, sentenceIndex) =>
  sentence.text
    .replace(/--|[—–-]/g, " ")
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .map((text) => ({ text, sentence: sentenceIndex })),
);
writeFileSync(output, JSON.stringify({ paragraphs: paragraphs.length, sentences, words }));
console.log(`${paragraphs.length} paragraphs, ${sentences.length} sentences, ${words.length} words`);
