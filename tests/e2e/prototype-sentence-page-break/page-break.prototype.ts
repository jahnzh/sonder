// PROTOTYPE, throwaway (jahnzh/sonder#457): can the reader read, from what epub.js rendered, the first
// word of a sentence that lies on the next page? See README.md in this folder. Not part of the suite.
//
//   npm run build
//   npx playwright test -c tests/e2e/prototype-sentence-page-break/playwright.config.ts
//   PROTOTYPE_EPUB=/path/book.epub PROTOTYPE_MAP=/path/intervals.json ... adds one real book.
import { test, expect, type Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { readerFixture } from "../../reader-fixture";

const here = import.meta.dirname;
const out = resolve(here, "../../../artifacts/prototype-page-break");
mkdirSync(out, { recursive: true });
const script = buildSync({ entryPoints: [resolve(here, "measure.ts")], bundle: true, format: "iife", write: false, target: "es2020" }).outputFiles[0].text;

// ---- A fixture whose sentences are long enough to cross pages at every size. ----
const SHORT = "the of and a to in is that it was for on with as his her they at be this from have not but had by one all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know".split(" ");
const LONG = ["inter&#173;nation&#173;al&#173;isa&#173;tion", "coun&#173;ter&#173;rev&#173;o&#173;lu&#173;tion&#173;ar&#173;ies", "in&#173;com&#173;pre&#173;hen&#173;si&#173;bil&#173;i&#173;ties", "un&#173;char&#173;ac&#173;ter&#173;is&#173;ti&#173;cal&#173;ly", "dis&#173;pro&#173;por&#173;tion&#173;ate&#173;ness", "elec&#173;tro&#173;en&#173;ceph&#173;a&#173;lo&#173;graph&#173;ic"];
function generator(seed: number) {
  let state = seed;
  const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const sentence = (count: number, options: { long?: boolean; emphasis?: boolean; insert?: string } = {}) => {
    const words = Array.from({ length: count }, (_, i) => (options.long && i % 3 === 1 ? pick(LONG) : pick(SHORT)));
    words[0] = words[0][0].toUpperCase() + words[0].slice(1);
    for (let i = 6; i < count - 2; i += 5 + Math.floor(random() * 9)) words[i] += ",";
    if (options.emphasis && count > 12) {
      const at = 4 + Math.floor(random() * (count - 8));
      words[at] = `<em>${words[at]}`;
      words[at + 1] = `${words[at + 1]}</em>`;
    }
    if (options.insert) words.splice(Math.floor(count / 2), 0, options.insert);
    return `${words.join(" ")}.`;
  };
  return { random, sentence };
}
// The reader's sanitiser drops an inline <svg>, so in the main fixture this is no picture at all (it ran that way).
const inlineSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="300"><rect width="220" height="300" fill="#888"/></svg>`;
// A real picture: a file of the book, which the sanitiser keeps.
const pictureTag = `<img src="pic.svg" width="220" height="300" alt=""/>`;
async function withPictureFile(epub: Buffer) {
  const zip = await JSZip.loadAsync(epub);
  zip.file("OEBPS/pic.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="300"><rect width="220" height="300" fill="#888"/></svg>`);
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  zip.file("OEBPS/content.opf", opf.replace("<manifest>", '<manifest><item id="pic" href="pic.svg" media-type="image/svg+xml"/>'));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
function chapterOne(picture = inlineSvg) {
  const { random, sentence } = generator(457);
  let html = "";
  for (let p = 0; p < 34; p++) {
    if (p % 4 === 0) html += `<h2>Part ${p / 4 + 1} of the long walk</h2>`;
    if (p === 10) html += `<p>${sentence(480)}</p>`;
    else if (p === 20) html += `<p>${sentence(30)} ${sentence(60, { insert: picture })} ${sentence(30)}</p>`;
    else html += `<p>${Array.from({ length: 2 + Math.floor(random() * 2) }, () => sentence(25 + Math.floor(random() * 46), { emphasis: random() < 0.5 })).join(" ")}</p>`;
  }
  return html;
}
function chapterTwo() {
  const { random, sentence } = generator(4570);
  let html = "";
  for (let p = 0; p < 26; p++)
    html += `<p>${Array.from({ length: 2 + Math.floor(random() * 2) }, () => sentence(20 + Math.floor(random() * 21), { long: true })).join(" ")}</p>`;
  html += `<p>${Array.from({ length: 12 }, () => sentence(34).replace(/^((?:\S+ ){17})/, "$1<br/>")).join("<br/>")}</p>`;
  return html;
}

async function importEpub(page: Page, name: string, buffer: Buffer) {
  const upload = await page.request.post("/api/ebooks/import", { multipart: { file: { name, mimeType: "application/epub+zip", buffer } } });
  expect(upload.ok(), await upload.text()).toBe(true);
  return (await upload.json()).id as string;
}
async function openReader(page: Page, ebookId: string, size: number) {
  await page.goto("about:blank");
  const appearance = await (await page.request.get("/api/appearance")).json();
  const saved = await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, mode: "paginated", display: "book", size } } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto(`/#reader/${ebookId}`);
  await expect(page.getByRole("dialog", { name: "Reader" })).toBeVisible();
  await expect(page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe")).toBeVisible({ timeout: 30000 });
  // Served from the app's own origin: the app's policy refuses inline scripts.
  await page.route("**/__pb.js", (route) => route.fulfill({ body: script, contentType: "text/javascript" }));
  await page.addScriptTag({ url: "/__pb.js" });
  await page.waitForFunction(() => {
    try {
      return !!(window as any).__pb.findRendition().manager?.layout;
    } catch {
      return false;
    }
  });
}
const quantile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
function summarise(results: any[]) {
  const ok = results.filter((result) => !result.error);
  const sum = (key: string) => ok.reduce((total, result) => total + result[key], 0);
  const all = ok.flatMap((result) => result.all);
  const seconds = all.map((entry: any) => entry.offMidpoint).filter((value: number | null) => value !== null).map(Math.abs).sort((a: number, b: number) => a - b);
  const fraction = all.map((entry: any) => Math.abs(entry.fraction - 0.5)).sort((a: number, b: number) => a - b);
  const durations = all.map((entry: any) => entry.duration).filter((value: number | null) => value !== null).sort((a: number, b: number) => a - b);
  const round = (value: number | null, digits = 3) => (value === null ? null : Number(value.toFixed(digits)));
  return {
    sections: ok.length,
    errors: results.length - ok.length,
    pages: sum("pagesInSection"),
    sentences: sum("sentences"),
    crossing: sum("crossing"),
    breaks: sum("breaks"),
    threePlus: sum("threePlus"),
    splitWordBreaks: sum("splitWordBreaks"),
    hyphenatedWords: sum("hyphenatedWords"),
    missingBlocks: sum("missingBlocks"),
    unrendered: sum("unrendered"),
    textMismatch: sum("textMismatch"),
    linearVsBinary: sum("linearVsBinary"),
    linearVsFast: sum("linearVsFast"),
    linearVsCaret: sum("linearVsCaret"),
    caretNull: sum("caretNull"),
    msPerSentenceCheck: round(sum("msCheck") / Math.max(1, sum("sentences"))),
    msPerCrossingLinear: round(sum("msLinear") / Math.max(1, sum("crossing"))),
    msPerCrossingBinary: round(sum("msBinary") / Math.max(1, sum("crossing"))),
    msPerCrossingCaret: round(sum("msCaret") / Math.max(1, sum("crossing"))),
    maxBinaryMs: round(Math.max(0, ...ok.map((result) => result.maxBinaryMs))),
    msPerSentenceFastCheck: round(sum("msFastCheck") / Math.max(1, sum("sentences"))),
    msPerCrossingFast: round(sum("msFast") / Math.max(1, sum("crossing"))),
    maxFastMs: round(Math.max(0, ...ok.map((result) => result.maxFastMs))),
    fractionFromMiddle: { median: round(quantile(fraction, 0.5)), p90: round(quantile(fraction, 0.9)) },
    secondsFromMidpoint: { n: seconds.length, median: round(quantile(seconds, 0.5), 2), p90: round(quantile(seconds, 0.9), 2), max: round(seconds.at(-1) ?? null, 2) },
    sentenceSeconds: { median: round(quantile(durations, 0.5), 2), p90: round(quantile(durations, 0.9), 2) },
    geometry: ok[0]?.geometry,
  };
}
type Run = { label: string; summary: ReturnType<typeof summarise>; disagreements: any[]; samples: any[] };
async function measure(page: Page, label: string, ebookId: string, options: { sections?: number[]; intervals?: Record<string, unknown> | null; keep?: number } = {}): Promise<Run> {
  const results = await page.evaluate((input) => (window as any).__pb.run(input), { ebookId, ...options });
  const run = {
    label,
    summary: summarise(results),
    disagreements: results.flatMap((result: any) => (result.disagreements || []).map((entry: any) => ({ section: result.section, ...entry }))),
    samples: results.flatMap((result: any) => (result.samples || []).map((entry: any) => ({ section: result.section, ...entry }))),
  };
  console.log(`\n[${label}]`, JSON.stringify(run.summary));
  if (run.disagreements.length) console.log(`[${label}] disagreements`, JSON.stringify(run.disagreements.slice(0, 6)));
  return run;
}
/** Two screenshots of one sentence: the page it starts on and the page after, with the break word outlined. */
async function picture2(page: Page, ebookId: string, sample: any, name: string) {
  const manifest = await (await page.request.get(`/api/reader/${ebookId}`)).json();
  const section = manifest.sections.find((value: any) => value.index === sample.section);
  const fragment = section.paragraphs.find((value: any) => value.id === sample.id);
  await page.evaluate((href) => (window as any).__pb.show(href), section.href);
  const cfi = await page.evaluate(([index, value, breaks]) => (window as any).__pb.mark(index, value, breaks), [sample.section, fragment, sample.linear] as const);
  const viewport = page.locator(".reader-room:not(.inline-reader) .reader-viewport");
  for (let turn = 0; turn <= Math.min(2, sample.linear.length); turn++) {
    await page.evaluate(([target, turns]) => (window as any).__pb.show(target, turns), [cfi, turn] as const);
    await viewport.screenshot({ path: resolve(out, `${name}-page${turn + 1}.png`) });
  }
}
const save = (name: string, data: unknown) => writeFileSync(resolve(out, `${name}.json`), JSON.stringify(data, null, 1));

test("fixture: sizes, a resize, a spread, soft hyphens, three pages, a picture", async ({ page, browserName }) => {
  const ebookId = await importEpub(page, "Page breaks.epub", await readerFixture({ title: "Page break prototype", bodies: [chapterOne(), chapterTwo()] }));
  const runs: Run[] = [];
  for (const size of [14, 19, 24, 30]) {
    await openReader(page, ebookId, size);
    const run = await measure(page, `${browserName} fixture size ${size}`, ebookId, { keep: 3 });
    runs.push(run);
    if (size === 19) {
      const wanted = [run.samples[0], run.samples.find((sample) => sample.linear.length > 1), run.samples.find((sample) => sample.split), run.samples.find((sample) => sample.section === 0 && sample.words > 100 && sample.words < 130)].filter(Boolean);
      for (const [index, sample] of wanted.entries()) await picture2(page, ebookId, sample, `${browserName}-fixture-${index}`);
    }
  }
  // A resize while the reader is open, then a landscape window wide enough for two pages side by side.
  await openReader(page, ebookId, 19);
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(1500);
  runs.push(await measure(page, `${browserName} fixture size 19 after resize to 430x932`, ebookId));
  await page.setViewportSize({ width: 932, height: 430 });
  await page.waitForTimeout(1500);
  runs.push(await measure(page, `${browserName} fixture size 19 landscape 932x430`, ebookId));
  // A desktop window: wide enough for epub.js to put two pages side by side, if the reader lets it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1500);
  runs.push(await measure(page, `${browserName} fixture size 19 desktop 1440x900`, ebookId));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    runs.push(await measure(page, "chromium fixture size 19, CPU slowed 6x", ebookId));
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
  save(`${browserName}-fixture`, runs);
  for (const run of runs) {
    expect.soft(run.summary.errors, run.label).toBe(0);
    expect.soft(run.summary.crossing, run.label).toBeGreaterThan(0);
  }
});

test("one real book", async ({ page, browserName }) => {
  const epub = process.env.PROTOTYPE_EPUB;
  test.skip(!epub || !existsSync(epub), "set PROTOTYPE_EPUB to an EPUB file");
  const intervals = process.env.PROTOTYPE_MAP && existsSync(process.env.PROTOTYPE_MAP) ? JSON.parse(readFileSync(process.env.PROTOTYPE_MAP, "utf8")) : null;
  const ebookId = await importEpub(page, "Real book.epub", readFileSync(epub!));
  const runs: Run[] = [];
  for (const size of [19, 24]) {
    await openReader(page, ebookId, size);
    const run = await measure(page, `${browserName} real book size ${size}`, ebookId, { intervals, keep: 1 });
    runs.push(run);
    if (size === 19) for (const [index, sample] of run.samples.filter((value) => value.words > 25).slice(0, 3).entries()) await picture2(page, ebookId, sample, `${browserName}-real-${index}`);
  }
  save(`${browserName}-real`, runs.map((run) => ({ ...run, samples: run.samples.map((sample) => ({ ...sample, around: "(text of the book left out)" })), disagreements: run.disagreements.map((entry) => ({ ...entry, around: "(text of the book left out)" })) })));
  for (const run of runs) expect.soft(run.summary.errors, run.label).toBe(0);
});

test("fixture: a picture in the middle of a sentence", async ({ page, browserName }) => {
  const ebookId = await importEpub(page, "Page breaks picture.epub", await withPictureFile(await readerFixture({ title: "Page break picture prototype", bodies: [chapterOne(pictureTag), chapterTwo()] })));
  const manifest = await (await page.request.get(`/api/reader/${ebookId}`)).json();
  const section = manifest.sections[0];
  const rows = [];
  for (const size of [14, 19, 24, 30]) {
    await openReader(page, ebookId, size);
    await page.evaluate((href) => (window as any).__pb.show(href), section.href);
    const blocks: number[] = await page.evaluate((index) => (window as any).__pb.pictureBlocks(index), section.index);
    const ids = new Set(section.paragraphs.filter((fragment: any) => blocks.includes(fragment.blockIndex)).map((fragment: any) => fragment.id));
    const seen = await page.evaluate(() => {
      const doc = (window as any).__pb.findRendition().getContents()[0].document as Document;
      return { svg: doc.querySelectorAll("svg").length, img: doc.querySelectorAll("img").length, rect: doc.querySelectorAll("rect").length };
    });
    console.log(`[${browserName} picture size ${size}] picture blocks`, JSON.stringify(blocks), "sentences in them", JSON.stringify([...ids]), "in page", JSON.stringify(seen));
    const run = await measure(page, `${browserName} picture size ${size}`, ebookId, { sections: [section.index], keep: 999 });
    for (const sample of run.samples.filter((value) => ids.has(value.id))) {
      const fastAgrees = JSON.stringify(sample.linear) === JSON.stringify(sample.fast),
        caretAgrees = JSON.stringify(sample.linear) === JSON.stringify(sample.caret);
      rows.push({ size, id: sample.id, words: sample.words, pages: sample.pages, linear: sample.linear, fast: sample.fast, caret: sample.caret, fastAgrees, caretAgrees, around: sample.around });
      // The sentence with the picture in it, at every size where it crosses a page.
      if (sample.words > 50) await picture2(page, ebookId, sample, `${browserName}-picture-size${size}`);
    }
  }
  console.log(`\n[${browserName} picture]`, JSON.stringify(rows));
  save(`${browserName}-picture`, rows);
  // Finding: the hit-test is wrong beside a picture (it lands on the picture's box), the word boxes are right.
  // See the screenshots. So only the word boxes are asserted here.
  expect.soft(rows.every((row) => row.fastAgrees)).toBe(true);
  expect.soft(rows.some((row) => row.words > 50)).toBe(true);
});
