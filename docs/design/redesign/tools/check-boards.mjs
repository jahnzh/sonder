// Renders the boards of ../project in Chromium at their own size: reports clipped or cut-off content and markup
// the canvas fails on silently, and writes one screenshot per board to ./out/shots.
//   node check-boards.mjs [Board.dc.html ...]    check all boards, or only the named ones
//   node check-boards.mjs --pages                also rebuild ./out/preview (the boards of pages.json, several per page)
// An ellipsis on a long title and the Library chip row running off the edge are reported and are on purpose.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.SONDER_DESIGN_PROJECT ?? join(here, '..', 'project');
const SHOTS = join(here, 'out', 'shots');
const PAGES = join(here, 'out', 'preview');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(PAGES, { recursive: true });
const { chromium } = createRequire(join(here, '..', '..', '..', '..', 'package.json'))('playwright');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? '/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const ACCENT = '#dd8966';
const FONTS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Manrope:wght@600;700&family=Literata:wght@400&display=swap';

const index = JSON.parse(readFileSync(join(PROJECT, 'canvas.json'), 'utf8'));
const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const names = index.order.filter((name) => !only.length || only.includes(name));

/** The board's helmet and root element, as the canvas runtime would mount them. */
function parts(name) {
  const html = readFileSync(join(PROJECT, name), 'utf8');
  const found = html.match(/<x-dc>\s*<helmet>([\s\S]*?)<\/helmet>\s*([\s\S]*?)\s*<\/x-dc>/);
  if (!found) throw new Error(`${name}: no <x-dc> with a <helmet>`);
  return { html, helmet: found[1], root: found[2] };
}

/** Markup problems the canvas fails on silently: unclosed elements, unquoted attributes, stray holes, emoji. */
function lint(name, { html, root }) {
  const problems = [];
  if (!html.includes('<script src="./support.js"></script>')) problems.push('the support.js head line is missing');
  if (!html.includes('<script type="text/x-dc" data-dc-script')) problems.push('the data-dc-script block is missing');
  const voids = new Set(['input', 'link', 'meta', 'br', 'hr', 'img']);
  const open = [];
  for (const tag of root.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s[^<>]*)?)>/g)) {
    const [, closing, element, rest] = tag;
    if (closing) {
      const top = open.pop();
      if (top !== element) problems.push(`</${element}> closes <${top ?? 'nothing'}>`);
    } else if (!rest.trimEnd().endsWith('/') && !voids.has(element)) open.push(element);
    const bare = rest.replace(/[\w:-]+\s*=\s*"[^"]*"/g, '').replace(/\/$/, '').trim();
    if (bare) problems.push(`<${element}> has an attribute without a quoted value: ${bare.slice(0, 40)}`);
  }
  if (open.length) problems.push(`left open: ${open.join(', ')}`);
  const holes = root.replaceAll('{{accent}}', '').match(/[{}]/g);
  if (holes) problems.push(`${holes.length} stray brace(s)`);
  if (/\p{Extended_Pictographic}/u.test(root.replace(/[›·−×…]/g, ''))) problems.push('contains an emoji');
  return problems;
}

const standalone = ({ helmet, root }) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">${helmet}</head><body>${root.replaceAll('{{accent}}', ACCENT)}</body></html>`;

/** Runs in the page: everything that is cut off, squeezed or pushed outside its board. */
function measure() {
  const found = [];
  const root = document.body.firstElementChild;
  const box = root.getBoundingClientRect();
  const say = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (el.dataset.clip) continue;
    const clipsY = style.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 1;
    const clipsX = style.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 1;
    if (clipsY || clipsX)
      found.push(`${clipsX && style.textOverflow === 'ellipsis' ? 'ellipsis' : 'clipped'} <${el.tagName.toLowerCase()}> "${say(el)}" needs ${el.scrollWidth}x${el.scrollHeight}, has ${el.clientWidth}x${el.clientHeight}`);
    const rect = el.getBoundingClientRect();
    if (rect.width && rect.height && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5))
      found.push(`outside <${el.tagName.toLowerCase()}> "${say(el)}" spans ${Math.round(rect.left)}..${Math.round(rect.right)}`);
  }
  // A face is fetched only where a board uses it, so ask what was fetched rather than for fixed faces.
  const faces = [...document.fonts];
  const fonts = faces.some((font) => font.status === 'loaded') ? faces.filter((font) => font.status === 'error').map((font) => font.family) : ['none'];
  return { width: Math.round(box.width), height: Math.round(box.height), needs: root.scrollHeight, page: document.documentElement.scrollHeight, found, fonts };
}

const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;
for (const name of names) {
  const frame = index.boards[name];
  const board = parts(name);
  const problems = lint(name, board);
  const page = await browser.newPage({ viewport: { width: frame.w, height: frame.h } });
  await page.setContent(standalone(board), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(measure);
  if (result.fonts.length) problems.push(`fonts not loaded: ${result.fonts.join(', ')}`);
  if (result.width !== frame.w) problems.push(`root is ${result.width} wide, the frame ${frame.w}`);
  if (Math.max(result.height, result.needs, result.page) > frame.h) problems.push(`needs ${Math.max(result.height, result.needs, result.page)} high, the frame is ${frame.h}`);
  if (frame.expand === 'fill' && result.height < frame.h) problems.push(`page is ${result.height} high, the frame ${frame.h}`);
  problems.push(...result.found);
  await page.screenshot({ path: join(SHOTS, name.replace('.dc.html', '.png')) });
  await page.close();
  failures += problems.length;
  console.log(`${problems.length ? 'CHECK' : 'ok   '} ${name} ${frame.w}x${frame.h}${problems.map((problem) => `\n        ${problem}`).join('')}`);
}

/** A review page: boards side by side under their names, phones at 80%, desktop boards fitted to the width. */
function reviewPage(title, list) {
  const figures = list
    .map((name) => {
      const frame = index.boards[name];
      const root = parts(name).root.replaceAll('{{accent}}', ACCENT);
      const wide = frame.w > 400;
      const inner = wide ? `<div class="frame" data-fit="${frame.w}" style="width: ${frame.w}px">${root}</div>` : `<div class="frame phone">${root}</div>`;
      return `<figure${wide ? ' class="wide"' : ''}><figcaption>${frame.title}</figcaption>${inner}</figure>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link href="${FONTS}" rel="stylesheet">
<style>
html, body { margin: 0; }
body { padding: 4px 4px 16px; font-family: system-ui, sans-serif; color: var(--foreground, CanvasText); }
.boards { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 24px 20px; }
figure { margin: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
figure.wide { width: 100%; }
figcaption { font-size: 13px; line-height: 18px; font-weight: 600; color: var(--muted-foreground, GrayText); }
.frame { border-radius: 14px; overflow: hidden; outline: 1px solid var(--border, rgba(127, 127, 127, 0.4)); }
.frame.phone { zoom: 0.8; width: fit-content; }
.frame a { color: #dd8966; }
</style>
</head>
<body>
<div class="boards">
${figures}
</div>
<script>
function fit() {
  for (const frame of document.querySelectorAll('[data-fit]')) {
    const width = frame.parentElement.clientWidth;
    if (width > 0) frame.style.zoom = Math.min(1, width / Number(frame.dataset.fit));
  }
}
new ResizeObserver(fit).observe(document.body);
addEventListener('load', fit);
fit();
// The boards link to each other on the canvas; here those files do not exist.
document.addEventListener('click', (event) => { if (event.target.closest('a')) event.preventDefault(); });
</script>
</body>
</html>
`;
}

const pages = JSON.parse(readFileSync(join(here, 'pages.json'), 'utf8'));
if (process.argv.includes('--pages')) {
  for (const [file, { title, boards, width }] of Object.entries(pages)) {
    const html = reviewPage(title, boards);
    writeFileSync(join(PAGES, `${file}.html`), html);
    const page = await browser.newPage({ viewport: { width: width ?? 1400, height: 800 } });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(SHOTS, `page-${file}.png`), fullPage: true });
    await page.close();
    console.log(`page  ${file}.html ${Math.round(html.length / 1024)} KB`);
  }
}
await browser.close();
console.log(failures ? `${failures} thing(s) to check` : 'Nothing clipped, nothing left open.');
