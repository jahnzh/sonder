#!/usr/bin/env node
// Puts each screenshot of slice 13 (Library, Discover, Settings and the shell) beside its board, the slice's final
// check (#583). The screenshots come from the slice's own browser specs, run in Chromium; each writes its pictures
// where it always has (OUT/, artifacts/, artifacts/redesign-581/):
//   npx playwright test --project=chromium discover get-recording library-redesign library-picker shell \
//     settings-pages settings-server sign-in
//   node scripts/slice13-board-pairs.mjs <dir>     writes <dir>/boards, <dir>/pairs (one per state and size), <dir>/sheets
// Every board of this slice is drawn at 390 by 844 except DesktopLibrary and DesktopSettings; a desktop screenshot of a
// state drawn only for the phone stands beside the phone board (spec #572: on a desktop the same parts, centred).
// Set PLAYWRIGHT_CHROMIUM_EXECUTABLE if the pinned Chromium is missing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = join(root, "docs/design/redesign/project");
const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/slice13-board-pairs.mjs <dir>");
  process.exit(2);
}
const PINNED = "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync(PINNED) ? PINNED : undefined);
const canvas = JSON.parse(readFileSync(join(PROJECT, "canvas.json"), "utf8"));

/** Each part: [pair's name, board, screenshot (from the repository's root), the state]. */
const PARTS = {
  discover: [
    ["discover-start-phone", "Discover.dc.html", "OUT/discover-start-phone.png", "Discover, before a search (390 by 844)"],
    ["discover-start-desktop", "Discover.dc.html", "OUT/discover-start-desktop.png", "Discover, before a search (desktop)"],
    ["discover-results-phone", "DiscoverResults.dc.html", "OUT/discover-results-phone.png", "Discover, results (390 by 844)"],
    ["discover-results-desktop", "DiscoverResults.dc.html", "OUT/discover-results-desktop.png", "Discover, results (desktop)"],
    ["discover-nothing-phone", "DiscoverNothing.dc.html", "OUT/discover-nothing-phone.png", "Discover, nothing found (390 by 844)"],
    ["discover-nothing-desktop", "DiscoverNothing.dc.html", "OUT/discover-nothing-desktop.png", "Discover, nothing found (desktop)"],
    ["discover-series-phone", "DiscoverSeries.dc.html", "OUT/discover-series-phone.png", "Discover, series (390 by 844)"],
    ["discover-series-desktop", "DiscoverSeries.dc.html", "OUT/discover-series-desktop.png", "Discover, series (desktop)"],
    ["get-recording-phone", "GetRecording.dc.html", "OUT/get-recording-phone.png", "The Get sheet without a book (390 by 844)"],
    ["get-recording-desktop", "GetRecording.dc.html", "OUT/get-recording-desktop.png", "The Get sheet without a book (desktop)"],
  ],
  library: [
    ["library-grid-phone", "Library.dc.html", "OUT/library-phone.png", "Library, grid (390 by 844)"],
    ["library-grid-desktop", "DesktopLibrary.dc.html", "OUT/library-desktop.png", "Library, grid (desktop)"],
    ["library-list-phone", "LibraryList.dc.html", "OUT/library-list-phone.png", "Library, list (390 by 844)"],
    ["library-list-desktop", "LibraryList.dc.html", "OUT/library-list-shelf-desktop.png", "Library, list with a Hardcover shelf (desktop)"],
    ["library-picker-phone", "LibrarySort.dc.html", "OUT/library-picker-phone.png", "Library, the sort-and-view picker (390 by 844)"],
    ["library-picker-desktop", "DesktopLibrary.dc.html", "OUT/library-picker-desktop.png", "Library, the picker under its button (desktop)"],
    ["library-shelf-phone", "LibraryShelf.dc.html", "OUT/library-shelf-phone.png", "Library, a Hardcover shelf and its clear chip (390 by 844)"],
    ["library-shelf-desktop", "LibraryShelf.dc.html", "OUT/library-list-shelf-desktop.png", "Library, a Hardcover shelf and its clear chip (desktop)"],
    ["library-offline-phone", "LibraryOffline.dc.html", "artifacts/redesign-581/shell-offline-library-mobile.png", "Library, no connection (390 by 844)"],
    ["library-offline-desktop", "LibraryOffline.dc.html", "artifacts/redesign-581/shell-offline-library-desktop.png", "Library, no connection (desktop)"],
  ],
  settings: [
    ["settings-list-phone", "Settings.dc.html", "OUT/settings-list-phone.png", "Settings, the list (390 by 844)"],
    ["settings-list-desktop", "DesktopSettings.dc.html", "OUT/settings-list-desktop.png", "Settings, the list with Account beside it (desktop)"],
    ["settings-account-phone", "SettingsAccount.dc.html", "OUT/settings-page-account-phone.png", "Settings: Account (390 by 844)"],
    ["settings-account-desktop", "SettingsAccount.dc.html", "OUT/settings-page-account-desktop.png", "Settings: Account beside the list (desktop)"],
    ["settings-appearance-phone", "SettingsAppearance.dc.html", "OUT/settings-page-appearance-phone.png", "Settings: Appearance (390 by 844)"],
    ["settings-appearance-desktop", "SettingsAppearance.dc.html", "OUT/settings-page-appearance-desktop.png", "Settings: Appearance beside the list (desktop)"],
    ["settings-playback-phone", "SettingsPlayback.dc.html", "OUT/settings-page-playback-phone.png", "Settings: Playback (390 by 844)"],
    ["settings-playback-desktop", "SettingsPlayback.dc.html", "OUT/settings-page-playback-desktop.png", "Settings: Playback beside the list (desktop)"],
    ["settings-connections-phone", "DesktopSettings.dc.html", "OUT/settings-page-connections-phone.png", "Settings: Connections (390 by 844; drawn only beside the list)"],
    ["settings-connections-desktop", "DesktopSettings.dc.html", "OUT/settings-page-connections-desktop.png", "Settings: Connections beside the list (desktop)"],
    ["settings-users-phone", "SettingsUsers.dc.html", "OUT/settings-page-users-phone.png", "Settings: Users (390 by 844)"],
    ["settings-users-desktop", "SettingsUsers.dc.html", "OUT/settings-page-users-desktop.png", "Settings: Users beside the list (desktop)"],
    ["settings-library-phone", "SettingsLibrary.dc.html", "OUT/settings-page-library-phone.png", "Settings: Library and storage (390 by 844)"],
    ["settings-library-desktop", "SettingsLibrary.dc.html", "OUT/settings-page-library-desktop.png", "Settings: Library and storage beside the list (desktop)"],
    ["settings-app-phone", "SettingsApp.dc.html", "OUT/settings-page-app-phone.png", "Settings: App (390 by 844)"],
    ["settings-app-desktop", "SettingsApp.dc.html", "OUT/settings-page-app-desktop.png", "Settings: App beside the list (desktop)"],
  ],
  signin: [
    ["sign-in-phone", "SignIn.dc.html", "artifacts/sign-in-phone.png", "Sign in (390 by 844)"],
    ["sign-in-desktop", "SignIn.dc.html", "artifacts/sign-in-desktop.png", "Sign in (desktop)"],
    ["request-phone", "SignInRequest.dc.html", "artifacts/sign-in-request-phone.png", "Request an account (390 by 844)"],
    ["request-desktop", "SignInRequest.dc.html", "artifacts/sign-in-request-desktop.png", "Request an account (desktop)"],
    ["join-phone", "Join.dc.html", "artifacts/join-phone.png", "Join (390 by 844)"],
    ["join-desktop", "Join.dc.html", "artifacts/join-desktop.png", "Join (desktop)"],
    ["join-expired-phone", "JoinExpired.dc.html", "artifacts/join-expired-phone.png", "Join, a link that does not work (390 by 844)"],
    ["join-expired-desktop", "JoinExpired.dc.html", "artifacts/join-expired-desktop.png", "Join, a link that does not work (desktop)"],
  ],
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
/** A PNG's width, from its IHDR chunk. */
const pngWidth = (file) => readFileSync(file).readUInt32BE(16);

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
const index = [];
for (const [part, states] of Object.entries(PARTS)) {
  const pairs = [];
  for (const [name, boardName, shotPath, title] of states) {
    const shot = join(root, shotPath);
    if (!existsSync(shot)) {
      missing.push(shotPath);
      continue;
    }
    const boardFile = await board(boardName);
    const pairFile = join(out, "pairs", `${name}.png`);
    const width = canvas.boards[boardName].w + pngWidth(shot) + 3 * 24;
    await compose(
      `${STYLE}<h1>${escape(title)}</h1><div class="pair">
        <figure><figcaption>Board: ${escape(boardName)}</figcaption><img src="${dataUrl(boardFile)}"></figure>
        <figure><figcaption>Sonder (${escape(shotPath)})</figcaption><img src="${dataUrl(shot)}"></figure></div>`,
      width,
      pairFile,
    );
    pairs.push([pairFile, title, width]);
    index.push(`${name}.png\t${boardName}\t${shotPath}\t${title}`);
    console.log(`pair  ${pairFile}`);
  }
  // A sheet: every pair of the part, scaled to fit two to a row.
  const sheetFile = join(out, "sheets", `${part}.png`);
  const figures = pairs
    .map(([file, title, width]) => `<figure><figcaption>${escape(title)}</figcaption><img src="${dataUrl(file)}" style="width:${Math.min(width, 1600) / 2}px"></figure>`)
    .join("");
  await compose(`${STYLE}<h1>Slice 13, ${part}: each board beside Sonder</h1><div class="sheet">${figures}</div>`, 1760, sheetFile);
  console.log(`sheet ${sheetFile}`);
}
await browser.close();
writeFileSync(
  join(out, "pairs", "INDEX.tsv"),
  `pair\tboard\tscreenshot\tstate\n${index.join("\n")}\n`,
);
writeFileSync(join(out, "sheets", "README.txt"), "Left of each pair the board, right Sonder at 390 by 844 or at a desktop width.\n");
if (missing.length) {
  console.error(`missing app screenshots:\n${missing.join("\n")}`);
  process.exit(1);
}
