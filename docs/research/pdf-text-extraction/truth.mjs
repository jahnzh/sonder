// Scores <order>.book.json against a ground-truth text: an EPUB (read with `unzip`) or a Project Gutenberg .txt.
// Usage: node truth.mjs <book dir> <truth.epub|truth.txt> [layout|raw]
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
const [dir, truthPath, order = "layout"] = process.argv.slice(2);
const normalizeReaderText = (text) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const key = (text) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const entity = (text) => text.replace(/&nbsp;/g, " ").replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+)|[a-z]+);/gi, (all, name, dec, hex) =>
  dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" }[name.toLowerCase()] ?? " "));
let paragraphs;
if (truthPath.endsWith(".epub")) {
  const read = (name) => execFileSync("unzip", ["-p", truthPath, name], { maxBuffer: 1 << 28 }).toString("utf8");
  const opfPath = /full-path="([^"]+)"/.exec(read("META-INF/container.xml"))[1], opf = read(opfPath);
  const items = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map((m) => [/\bid="([^"]+)"/.exec(m[0])?.[1], /\bhref="([^"]+)"/.exec(m[0])?.[1]]));
  paragraphs = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].flatMap((m) => {
    const href = items.get(m[1]);
    if (!href || !/x?html?$/i.test(href)) return [];
    const html = read(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(href)));
    const body = html.replace(/[\s\S]*?<body[^>]*>/i, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
    return entity(body.replace(/<\/?(p|div|h\d|li|blockquote|br|tr|section|title)\b[^>]*>/gi, "\n\n").replace(/<[^>]+>/g, "")).split(/\n\s*\n/);
  });
} else {
  let text = fs.readFileSync(truthPath, "utf8").replace(/\r/g, "");
  const a = text.indexOf("*** START"), b = text.indexOf("*** END");
  text = text.slice(a < 0 ? 0 : text.indexOf("\n", a), b < 0 ? undefined : b).replace(/_/g, "");
  paragraphs = text.split(/\n\s*\n/);
}
const truth = paragraphs.flatMap((p) => [...segmenter.segment(normalizeReaderText(p))].map((s) => s.segment.trim()).filter(Boolean));
const truthAt = new Map(), truthCount = new Map();
truth.forEach((text, i) => { const k = key(text); truthCount.set(k, (truthCount.get(k) || 0) + 1); truthAt.set(k, i); });
const book = JSON.parse(fs.readFileSync(path.join(dir, `${order}.book.json`), "utf8")).filter((s) => !s.note);
const long = (text) => text.split(" ").length >= 6;
const mine = book.filter((s) => long(s.text)), mineKeys = new Set(book.map((s) => key(s.text)));
const matched = mine.filter((s) => truthAt.has(key(s.text)));
const sequence = matched.filter((s) => truthCount.get(key(s.text)) === 1).map((s) => truthAt.get(key(s.text)));
const tails = [];
for (const value of sequence) { let lo = 0, hi = tails.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < value) lo = mid + 1; else hi = mid; } tails[lo] = value; }
const truthLong = truth.filter(long);
// Hyphen decisions against the truth's vocabulary.
const vocabulary = new Set(), compounds = new Set();
for (const text of truth) { for (const w of text.toLowerCase().match(/\p{L}+(?:-\p{L}+)+/gu) || []) compounds.add(w); for (const w of text.toLowerCase().match(/\p{L}+/gu) || []) vocabulary.add(w); }
const hyphens = fs.readFileSync(path.join(dir, `${order}.hyphens.txt`), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const wrongJoin = [], wrongKeep = [];
let guessKeptRight = 0;
for (const [decision, pair] of hyphens) {
  const joined = pair.replace("-", "").toLowerCase(), compound = pair.toLowerCase();
  if (decision.startsWith("join") && !vocabulary.has(joined) && compounds.has(compound)) wrongJoin.push(pair);
  if (decision === "keep-guess" && compounds.has(compound) && !vocabulary.has(joined)) guessKeptRight++;
  if (decision.startsWith("keep") && vocabulary.has(joined) && !compounds.has(compound)) wrongKeep.push(pair);
}
const first = book.slice(0, 200), firstLong = first.filter((s) => long(s.text));
const result = {
  order, truthSentences: truth.length, bookSentences: book.length,
  matchShare: +(matched.length / (mine.length || 1)).toFixed(3),
  coverage: +(truthLong.filter((text) => mineKeys.has(key(text))).length / (truthLong.length || 1)).toFixed(3),
  inOrderShare: +(tails.length / (sequence.length || 1)).toFixed(4),
  first200Match: +(firstLong.filter((s) => truthAt.has(key(s.text))).length / (firstLong.length || 1)).toFixed(3),
  hyphens: hyphens.length, wrongJoin: wrongJoin.length, wrongKeep: wrongKeep.length, wrongKeepFromGuess: hyphens.filter(([d, pair]) => d === "keep-guess" && wrongKeep.includes(pair)).length, guessKeptRight,
};
console.log(path.basename(dir), JSON.stringify(result));
const unmatched = mine.filter((s) => !truthAt.has(key(s.text)));
fs.writeFileSync(path.join(dir, `${order}.truth.txt`), JSON.stringify(result) + "\nWRONG JOIN: " + wrongJoin.join(" ") + "\nWRONG KEEP: " + wrongKeep.join(" ") + "\n" +
  unmatched.filter((_, i) => i % Math.max(1, Math.floor(unmatched.length / 150)) === 0).map((s) => `${s.id}\tp${s.page + 1}\t${s.text}`).join("\n"));
