// Measures the reader's lookup from a sentence offset to a place in the page (#507) in Chromium: the
// per-character lookup it replaced (tests/reader-lookup-reference.ts) against the searched one
// (src/reader-lookup.ts), on the longest paragraph of the full-length book fixture and on one long
// paragraph made of that book's sentences. Each sentence is looked up as the highlight does it: its
// start and the end of its text. Usage: npx tsx scripts/measure-reader-lookup.ts [--throttle 6]
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import JSZip from "jszip";
import { longBookFixture, longBookSentence } from "../tests/long-book-fixture.ts";

const throttle = Number(process.argv[process.argv.indexOf("--throttle") + 1]) || 1;
const bundle = await build({
  stdin: {
    contents: `export { lookupIndex, placeAt } from "./src/reader-lookup.ts"; export { linearPlaceAt } from "./tests/reader-lookup-reference.ts";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  globalName: "lookup",
  write: false,
});
const zip = await JSZip.loadAsync(await longBookFixture());
const chapters = await Promise.all(
  Object.keys(zip.files).filter((name) => /^OEBPS\/c\d+\.xhtml$/.test(name)).map((name) => zip.file(name)!.async("string")),
);
const paragraphs = chapters.flatMap((html) => html.match(/<p>.*?<\/p>/g) || []);
const longest = paragraphs.reduce((a, b) => (b.length > a.length ? b : a));
// A long paragraph of a real book: 120 of the fixture's sentences, some with inline markup.
const long = `<p>${Array.from({ length: 120 }, (_, i) => (i % 9 === 4 ? `<em>${longBookSentence(0, i)}</em>` : longBookSentence(0, i))).join(" ")}</p>`;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
if (throttle > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });

const results = [];
for (const [label, html] of [["longest paragraph of the full-length book fixture", longest], ["long paragraph of 120 sentences", long]]) {
  await page.setContent(`<html><body>${html}</body></html>`);
  // tsx names the functions it passes to the page with a helper the page does not have.
  await page.addScriptTag({ content: `window.__name = (f) => f;\n${bundle.outputFiles[0].text}` });
  results.push({
    label,
    ...(await page.evaluate(() => {
      const { lookupIndex, placeAt, linearPlaceAt } = (window as any).lookup;
      const block = document.querySelector("p")!;
      const text = block.textContent || "";
      const normalised = text.normalize("NFKC").replace(/\s+/g, " ").trim();
      const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(normalised)].map((s) => ({
        start: s.index,
        end: s.index + s.segment.trim().length,
      }));
      // The block's walk, as Reader.tsx's rangeAt() makes it.
      const walk = () => {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        const items: { node: Node; isBreak: boolean; text: string }[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) items.push({ node, isBreak: false, text: node.textContent || "" });
        return items;
      };
      const time = (lookup: (start: number, end: number) => unknown) => {
        const each: number[] = [];
        for (const sentence of sentences) {
          const from = performance.now();
          lookup(sentence.start, sentence.end);
          each.push(performance.now() - from);
        }
        return { max: Math.max(...each), total: each.reduce((a, b) => a + b, 0) };
      };
      const textLength = (node: Node) => (node.textContent || "").length;
      const blockInfo = { node: block, childCount: block.childNodes.length };
      const present = (start: number, end: number) => {
          const items = walk();
          return [linearPlaceAt(items, blockInfo, start, textLength), linearPlaceAt(items, blockInfo, end, textLength)];
        },
        searched = (start: number, end: number) => {
          const index = lookupIndex(walk(), blockInfo);
          return [placeAt(index, start), placeAt(index, end)];
        };
      // One pass each first, so the compiler's warm-up is not counted.
      time(present);
      time(searched);
      const before = time(present),
        after = time(searched);
      // Both lookups give the same places in the browser's own text nodes.
      const same = sentences.filter(({ start, end }) => {
        const [a, b] = present(start, end),
          [c, d] = searched(start, end);
        return a.node === c.node && a.offset === c.offset && b.node === d.node && b.offset === d.offset;
      }).length;
      return { characters: text.length, sentences: sentences.length, same, before, after };
    })),
  });
}
await browser.close();
const ms = (value: number) => `${value.toFixed(2)} ms`;
console.log(`Chromium, CPU throttle ${throttle}x`);
for (const r of results)
  console.log(
    `${r.label}: ${r.characters} characters, ${r.sentences} sentences, same places for ${r.same}\n` +
      `  before (per-character): slowest sentence ${ms(r.before.max)}, whole paragraph ${ms(r.before.total)}\n` +
      `  after (searched):       slowest sentence ${ms(r.after.max)}, whole paragraph ${ms(r.after.total)}`,
  );
