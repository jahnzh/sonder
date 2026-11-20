// Prints the gate's signals and the measured cost for every book under <out dir>.
// Usage: node gate.mjs <out dir> [layout|raw]
import fs from "node:fs"; import path from "node:path";
const [root, order = "layout"] = process.argv.slice(2);
const terminal = (text) => /[.!?…]["'”’»)\]]*$/.test(text.trim());
console.log("book | pages | textPages | share | words/page | orderBad | paragraphs | brokenStart | dangling | letterTokens | furniture | hyphen join/keep | pdftotext s (bbox+raw) | pdftotext MB | pipeline s | pipeline MB | sizeMB(bbox)");
for (const name of fs.readdirSync(root).sort()) {
  const dir = path.join(root, name);
  if (!fs.existsSync(path.join(dir, "stats.json"))) continue;
  const stats = JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8")), o = stats[order];
  const book = JSON.parse(fs.readFileSync(path.join(dir, `${order}.book.json`), "utf8")).filter((s) => !s.note);
  const paragraphs = new Map();
  for (const sentence of book) (paragraphs.get(sentence.blockIndex) || paragraphs.set(sentence.blockIndex, []).get(sentence.blockIndex)).push(sentence.text);
  // Only paragraphs of running text count: eight words or more.
  const prose = [...paragraphs.values()].filter((list) => list.join(" ").split(" ").length >= 8);
  const broken = prose.filter((list) => /^\p{Ll}/u.test(list[0])).length / (prose.length || 1);
  const dangling = prose.filter((list) => !terminal(list.at(-1))).length / (prose.length || 1);
  const time = (mode) => fs.readFileSync(path.join(dir, `${mode}.time`), "utf8").trim().split(" ").map(Number);
  const [b, r] = [time("bbox-layout"), time("raw")];
  console.log([name, stats.pages, stats.textPages, stats.textPageShare, stats.wordsPerTextPage, stats.orderBadPageShare, prose.length, broken.toFixed(3), dangling.toFixed(3), o.letterTokenShare, o.furnitureLines, `${o.hyphenJoins}/${o.hyphenKept}`, (b[0] + r[0]).toFixed(2), Math.round(Math.max(b[1], r[1]) / 1024), (stats.totalMs / 1000).toFixed(1), stats.peakMb, (fs.statSync(path.join(dir, "bbox-layout.html")).size / 1e6).toFixed(0)].join(" | "));
}
