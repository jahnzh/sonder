#!/usr/bin/env node
// Puts each screenshot of Now playing and the reader's page beside its board (#596): renders the board's .dc.html in
// Chromium at the board's size, then writes one pair per state and size and one contact sheet per size.
//   SONDER_SHOTS_DIR=<dir>/app npx playwright test tests/e2e/now-playing-boards.spec.ts --project=chromium
//   node scripts/now-playing-board-pairs.mjs <dir>     reads <dir>/app, writes <dir>/boards, <dir>/pairs, <dir>/sheets
// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE if the pinned Chromium is missing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = join(root, "docs/design/redesign/project");
const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/now-playing-board-pairs.mjs <dir with app/>");
  process.exit(2);
}
const PINNED = "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(PINNED) ? PINNED : undefined);
const canvas = JSON.parse(readFileSync(join(PROJECT, "canvas.json"), "utf8"));

/** Each part: [board, app screenshot, the state's name]. Every state is shot at 390 by 844 and at 1280 by 800; a state
 * with no desktop board of its own is put beside its phone board. */
const STATES = [
  ["NowPlaying.dc.html", "DesktopNowPlaying.dc.html", "listen", "Listen"],
  ["Reader.dc.html", "DesktopReader.dc.html", "read-rest", "Read at rest"],
  ["ReaderControls.dc.html", "DesktopReader.dc.html", "read-controls", "Read with the controls shown"],
  ["ReaderScroll.dc.html", null, "scroll", "Scroll mode"],
  ["ReaderAppearance.dc.html", null, "appearance", "Appearance docked"],
  ["ReaderSpeed.dc.html", null, "speed", "Speed in the foot"],
  ["ReaderSleep.dc.html", null, "sleep", "The sleep timer in the foot"],
  ["Chapters.dc.html", null, "chapters", "Chapters"],
  ["ReaderBookmarks.dc.html", null, "bookmarks", "Bookmarks"],
  ["ReaderSearch.dc.html", null, "search", "Search"],
  ["ReaderUndo.dc.html", null, "undo", "Message: Listening from here, Undo"],
  ["ReaderConfirm.dc.html", null, "confirm", "Message: Bookmark removed, Undo"],
  ["ReaderError.dc.html", null, "error", "Message: an error"],
  ["ReaderConflict.dc.html", null, "conflict", "Message: a place saved elsewhere"],
  ["ReaderUpdate.dc.html", null, "update", "Message: an update is ready"],
  ["ReaderEbookOnly.dc.html", null, "ebook-only", "A book with only an ebook, at rest"],
  ["ReaderEbookOnly.dc.html", null, "ebook-only-controls", "A book with only an ebook, controls shown"],
];
const PARTS = {
  phone: STATES.map(([phone, , app, title]) => [phone, `${app}-phone`, `${title} (390 by 844)`]),
  desktop: STATES.map(([phone, desktop, app, title]) => [desktop ?? phone, `${app}-desktop`, `${title} (1280 by 800${desktop ? "" : "; no desktop board, beside the phone board"})`]),
};

/** The board's helmet and root, as the canvas mounts them (docs/design/redesign/tools/check-boards.mjs). */
function standalone(name) {
  const html = readFileSync(join(PROJECT, name), "utf8");
  const found = html.match(/<x-dc>\s*<helmet>([\s\S]*?)<\/helmet>\s*([\s\S]*?)\s*<\/x-dc>/);
  if (!found) throw new Error(`${name}: no <x-dc> with a <helmet>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${found[1]}</head><body>${found[2].replaceAll("{{accent}}", "#dd8966")}</body></html>`;
}
const dataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
const escape = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
for (const dir of ["boards", "pairs", "sheets"]) mkdirSync(join(out, dir), { recursive: true });

async function board(name) {
  const file = join(out, "boards", name.replace(".dc.html", ".png"));
  if (existsSync(file)) return file;
  const { w, h } = canvas.boards[name];
  await page.setViewportSize({ width: w, height: h });
  // The fonts come from Google; without a network the board falls back to the system's faces.
  await page.setContent(standalone(name), { waitUntil: "load", timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.screenshot({ path: file });
  return file;
}

async function compose(html, width, file) {
  await page.setViewportSize({ width, height: 400 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: file, fullPage: true });
}
const STYLE = `<style>body{margin:0;background:#0b0f0b;color:#e6eadf;font:14px/1.4 system-ui,sans-serif}
.pair{display:flex;gap:24px;padding:16px;align-items:flex-start}.pair figure{margin:0}.pair figcaption{padding:0 0 8px;color:#a9b59d}
h1{font-size:18px;margin:0;padding:16px 16px 0}.sheet{display:flex;flex-wrap:wrap;gap:8px;padding:8px}.sheet figure{margin:0}
.sheet figcaption{padding:4px 8px;color:#a9b59d}img{display:block;border:1px solid #26331f}</style>`;

const missing = [];
for (const [part, states] of Object.entries(PARTS)) {
  const pairs = [];
  for (const [boardName, app, title] of states) {
    const shot = join(out, "app", `app-${app}.png`);
    if (!existsSync(shot)) {
      missing.push(shot);
      continue;
    }
    const boardFile = await board(boardName);
    const desktop = part === "desktop";
    const pairFile = join(out, "pairs", `${app}.png`);
    const width = desktop ? 2 * 1280 + 3 * 24 : 2 * 390 + 3 * 24;
    await compose(
      `${STYLE}<h1>${escape(title)}</h1><div class="pair">
        <figure><figcaption>Board: ${escape(boardName)}</figcaption><img src="${dataUrl(boardFile)}"></figure>
        <figure><figcaption>Sonder</figcaption><img src="${dataUrl(shot)}"></figure></div>`,
      width,
      pairFile,
    );
    pairs.push([pairFile, title, desktop]);
    console.log(`pair  ${pairFile}`);
  }
  // A sheet: every pair of the part at a quarter (desktop) or half (phone) of its size.
  const sheetFile = join(out, "sheets", `${part}.png`);
  const figures = pairs
    .map(([file, title, desktop]) => `<figure><figcaption>${escape(title)}</figcaption><img src="${dataUrl(file)}" style="width:${desktop ? 1300 : 420}px"></figure>`)
    .join("");
  await compose(`${STYLE}<h1>Now playing and the reader: ${part}, each board beside Sonder</h1><div class="sheet">${figures}</div>`, 1760, sheetFile);
  console.log(`sheet ${sheetFile}`);
}
await browser.close();
writeFileSync(join(out, "sheets", "README.txt"), "Left of each pair the board, right Sonder at the board's size.\n");
if (missing.length) {
  console.error(`missing app screenshots:\n${missing.join("\n")}`);
  process.exit(1);
}
