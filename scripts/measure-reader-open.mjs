// Measures what opening the reader costs on real books (ADR 0025, the reader plan #799): the time from opening Read to
// the first readable text, to the reader showing its place, to following the narration, the time of a jump to another
// narrated place, the bytes transferred and the JavaScript loaded. One desktop and one phone profile, cold and warm.
//
// It never runs on production. Start a copy first (scripts/reader-open-copy.sh start: the deployed image on a copy of
// the database) and point SONDER_VERIFY_URL at it. Even there every write the page sends is answered in the page and
// never reaches the server, so each run opens the books at the same saved places.
//
//   SONDER_VERIFY_URL=http://127.0.0.1:3106 node scripts/measure-reader-open.mjs \
//     [--books short=<ebook id>,average=<ebook id>,long=<ebook id>] [--runs 5] [--profiles desktop,phone] [--out <file.json>]
//
// Without --books it takes the shortest, the middle and the longest text among the books that have an EPUB with a
// reading sync map and were not listened to in the last 48 hours, and prints the choice; pass that choice as
// --books to measure the same books again. It reads the page only through what a reader of any kind has: the room
// (.inline-reader), its text band (.reader-viewport), the loading line (.reader-loading), data-current-passage and the
// follow highlight (.sonder-follow). Text counts as readable whether it is in the band itself or in a frame inside it,
// so the same script measures the reader after epub.js is gone.
import fs from "node:fs";
import path from "node:path";
import { chromium, devices } from "@playwright/test";
import { classifyTarget, verifyBaseURL } from "./live-check-target.mjs";
import { recentlyListened, RECENT_LISTENING_REASON } from "./live-check-recording.mjs";
import { intervalMiddle } from "./live-reader-samples.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const RUNS = Math.max(1, Number(option("runs", 5)) || 5);
const PROFILE_NAMES = option("profiles", "desktop,phone").split(",").filter(Boolean);
const OPEN_TIMEOUT = Number(option("open-timeout", 180)) * 1000;
const FOLLOW_TIMEOUT = 20_000;
const QUIET_MS = 1000;

// The phone is a mid-range Android: Chrome's Pixel 7 screen and touch, the processor four times slower than this
// machine's, and a mobile connection (10 Mbit/s down, 2 Mbit/s up, 40 ms each way). The desktop is unthrottled.
const PROFILES = {
  desktop: { context: { viewport: { width: 1280, height: 800 } }, cpu: 1, network: null },
  phone: {
    context: { ...devices["Pixel 7"] },
    cpu: 4,
    network: { offline: false, latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (2 * 1024 * 1024) / 8 },
  },
};

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const baseURL = verifyBaseURL({ ...process.env, SONDER_VERIFY_PRODUCTION: undefined });
if (classifyTarget(baseURL) !== "local-test") throw new Error("measure-reader-open runs on a copy only (scripts/reader-open-copy.sh)");
const origin = new URL(baseURL).origin;

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ---- Which books -----------------------------------------------------------------------------------------------

async function library(request) {
  const read = async (address) => {
    const response = await request.get(address);
    if (!response.ok()) throw new Error(`GET ${address} answered ${response.status()}`);
    return response.json();
  };
  const [ebooks, books, alignments] = await Promise.all([read("/api/ebooks"), read("/api/books"), read("/api/alignments")]);
  return { ebooks, books, alignments: alignments.jobs, read };
}

/** The EPUBs that can be measured: on the server, with a recording and a reading sync map that has intervals. */
function candidates({ ebooks, books, alignments }) {
  const recent = recentlyListened(books);
  return ebooks
    .filter((ebook) => ebook.format === "epub" && ebook.available)
    .map((ebook) => {
      const job = alignments.find((entry) => entry.ebookId === ebook.id && ["ready", "partial"].includes(entry.status) && entry.intervals?.length);
      const book = job && books.find((entry) => entry.recordingId === job.recordingId && entry.tracks?.length);
      return { ebook, job, book, recent: recent.has(ebook.workId) };
    })
    .filter((entry) => entry.job && entry.book);
}

async function chooseBooks(found, read) {
  const named = option("books", null);
  if (named) {
    return named.split(",").map((pair) => {
      const [label, id] = pair.split("=");
      const entry = found.find((candidate) => candidate.ebook.id === id);
      if (!entry) throw new Error(`--books ${label}: EPUB ${id} is not on the server with a recording and a reading sync map`);
      if (entry.recent && process.env.SONDER_VERIFY_ALLOW_RECENT !== "1")
        throw new Error(`--books ${label}: the book of EPUB ${id} was ${RECENT_LISTENING_REASON}; set SONDER_VERIFY_ALLOW_RECENT=1 to measure it anyway`);
      return { label, ...entry };
    });
  }
  // One EPUB a work, the one whose map covers the most, so the three are three books; then the shortest, the middle
  // and the longest text.
  const works = new Map();
  for (const entry of found.filter((candidate) => !candidate.recent)) {
    const known = works.get(entry.ebook.workId);
    if (!known || entry.job.intervals.length > known.job.intervals.length) works.set(entry.ebook.workId, entry);
  }
  if (works.size < 3) throw new Error(`Only ${works.size} books have an EPUB with a reading sync map and were not ${RECENT_LISTENING_REASON}`);
  const sized = [];
  for (const entry of works.values()) sized.push({ ...entry, text: await read(`/api/reader/${encodeURIComponent(entry.ebook.id)}`) });
  sized.sort((a, b) => characters(a.text) - characters(b.text));
  return [
    { label: "short", ...sized[0] },
    { label: "average", ...sized[sized.length >> 1] },
    { label: "long", ...sized.at(-1) },
  ];
}

const characters = (text) => text.sections.reduce((sum, section) => sum + section.paragraphs.reduce((count, sentence) => count + sentence.text.length, 0), 0);

// ---- In the page -----------------------------------------------------------------------------------------------

/** Runs in the page before the app: keeps writes off the server, finds the audio element and times the reader. */
function instrument({ origin, choices }) {
  if (window.top !== window) return;
  for (const [workId, ebookId] of Object.entries(choices)) localStorage.setItem(`reader-ebook:${workId}`, ebookId);
  const NativeAudio = window.Audio;
  const audio = [];
  window.Audio = class extends NativeAudio {
    constructor(...rest) {
      super(...rest);
      audio.push(this);
    }
  };
  // Every write is answered here, in the shapes the server answers (scripts/verification-safety.mjs), so the copy of
  // the database stays as it was and every run starts from the same saved places.
  const writes = [];
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return nativeFetch(input, init);
    const url = new URL(request.url);
    const body = await request.text().catch(() => "");
    const json = (() => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    })();
    const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    let answer = null;
    if (url.origin === origin) {
      if (request.method === "POST" && url.pathname === "/api/progress") answer = { progress: json };
      else if (request.method === "PUT" && /^\/api\/reader\/[^/]+\/progress$/.test(url.pathname)) {
        const { baseRevision, resolve, ...checkpoint } = json || {};
        answer = { checkpoint: { ...checkpoint, origin: checkpoint.origin || "reading", revision: (baseRevision || 0) + 1, updatedAt: Date.now() } };
      } else if (request.method === "PUT" && url.pathname === "/api/appearance") answer = json;
    }
    writes.push({ method: request.method, path: url.pathname, answered: !!answer });
    return answer ? reply(200, answer) : reply(403, { error: "Write blocked by the reader measurement" });
  };

  const readableAt = (doc, x, y, inside) => {
    const element = doc.elementFromPoint(x, y);
    if (!element || (inside && !inside.contains(element)) || element === inside) return false;
    if (element.localName === "iframe") {
      const inner = element.contentDocument;
      const box = element.getBoundingClientRect();
      return !!inner?.body && getComputedStyle(element).visibility !== "hidden" && readableAt(inner, x - box.left, y - box.top, null);
    }
    if (element === doc.documentElement || element === doc.body || element.closest?.('[role="status"]')) return false;
    for (const node of element.childNodes) if (node.nodeType === 3 && node.data.trim()) return true;
    return false;
  };
  const textShown = (band) => {
    const box = band.getBoundingClientRect();
    if (box.width < 50 || box.height < 50) return false;
    for (let row = 1; row < 12; row++)
      for (let column = 1; column < 8; column++)
        if (readableAt(document, box.left + (box.width * column) / 8, box.top + (box.height * row) / 12, band)) return true;
    return false;
  };
  // Where the follow highlight is drawn inside the band, as text: empty when none of it is in view. A jump is done
  // when this has changed, not when the old highlight is still on the page.
  const highlight = (band) => {
    const box = band.getBoundingClientRect();
    const drawn = [];
    for (const mark of band.querySelectorAll(".sonder-follow, .sonder-follow *")) {
      const rect = mark.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom)
        drawn.push([rect.left, rect.top, rect.width, rect.height].map(Math.round).join(","));
    }
    return drawn.join(";");
  };
  const highlightShown = (band) => highlight(band) !== "";
  const state = { marks: null, jump: null };
  const tick = () => {
    const room = document.querySelector(".inline-reader");
    const band = room?.querySelector(".reader-viewport");
    const now = performance.now();
    if (state.marks && band) {
      const marks = state.marks;
      const shown = textShown(band);
      if (shown && marks.text == null) marks.text = now - marks.start;
      if (shown && marks.place == null && !room.querySelector(".reader-loading")) marks.place = now - marks.start;
      if (marks.place != null && marks.follow == null && room.dataset.currentPassage && highlightShown(band)) {
        marks.follow = now - marks.start;
        marks.passage = room.dataset.currentPassage;
      }
    }
    if (state.jump && band && state.jump.done == null && room.dataset.currentPassage === state.jump.passage && textShown(band)) {
      const drawn = highlight(band);
      if (drawn && drawn !== state.jump.before) state.jump.done = now - state.jump.start;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__readerMeasure = {
    writes,
    state,
    audio: () => audio.find((element) => element.src) || null,
    open(workId) {
      state.marks = { start: performance.now(), text: null, place: null, follow: null, passage: null };
      location.hash = `#read/${encodeURIComponent(workId)}`;
    },
    jump(position, passage) {
      const element = audio.find((entry) => entry.src);
      const band = document.querySelector(".inline-reader .reader-viewport");
      state.jump = { start: performance.now(), passage, done: null, before: band ? highlight(band) : "" };
      element.currentTime = position;
    },
  };
}

// ---- Bytes -----------------------------------------------------------------------------------------------------

/** What a request is, by its address: ids are left out so the same kind adds up. */
function kindOf(url, type) {
  const { pathname } = new URL(url);
  if (/^\/api\/ebooks\/[^/]+\/file$/.test(pathname)) return "book file";
  if (/^\/api\/reader\/[^/]+$/.test(pathname)) return "book text";
  if (pathname.startsWith("/api/alignments")) return "reading sync map";
  if (pathname.startsWith("/api/media/") || type === "Media") return "audio";
  if (type === "Script") return "script";
  if (pathname.startsWith("/api/")) return `api ${pathname.split("/").slice(0, 4).join("/").replace(/\/[^/]*[0-9][^/]*$/, "/:id")}`;
  return type === "Font" ? "font" : type === "Stylesheet" ? "stylesheet" : type === "Image" ? "image" : "other";
}

async function watchNetwork(session) {
  const requests = new Map();
  let phase = "shell";
  let lastActivity = Date.now();
  const open = new Set();
  await session.send("Network.enable");
  session.on("Network.requestWillBeSent", ({ requestId, request, type }) => {
    if (!request.url.startsWith("http")) return;
    requests.set(requestId, { url: request.url, type, phase, transferred: 0, size: 0, cached: false, done: false });
    if (kindOf(request.url, type) !== "audio") open.add(requestId);
    lastActivity = Date.now();
  });
  session.on("Network.responseReceived", ({ requestId, response, type }) => {
    const entry = requests.get(requestId);
    if (!entry) return;
    entry.type = type;
    entry.status = response.status;
    entry.cached = !!response.fromDiskCache || !!response.fromPrefetchCache;
  });
  session.on("Network.requestServedFromCache", ({ requestId }) => {
    const entry = requests.get(requestId);
    if (entry) entry.cached = true;
  });
  session.on("Network.dataReceived", ({ requestId, dataLength }) => {
    const entry = requests.get(requestId);
    if (entry) entry.size += dataLength;
    lastActivity = Date.now();
  });
  const finish = (requestId, transferred) => {
    const entry = requests.get(requestId);
    if (entry) {
      entry.done = true;
      if (transferred != null) entry.transferred = transferred;
    }
    open.delete(requestId);
    lastActivity = Date.now();
  };
  session.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => finish(requestId, encodedDataLength));
  session.on("Network.loadingFailed", ({ requestId }) => finish(requestId, null));
  return {
    phase(name) {
      phase = name;
    },
    /** Resolves when nothing but audio has been on the wire for a second. */
    async quiet(timeout = 60_000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (!open.size && Date.now() - lastActivity >= QUIET_MS) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`The network did not go quiet in ${timeout / 1000} s: ${[...open].map((id) => requests.get(id)?.url).join(", ")}`);
    },
    /** The bytes of one phase: transferred over the wire, by kind, and each script with its size once unpacked. */
    summary(name) {
      const kinds = {};
      const scripts = [];
      let transferred = 0;
      let audio = 0;
      for (const entry of requests.values()) {
        if (entry.phase !== name) continue;
        const kind = kindOf(entry.url, entry.type);
        if (kind === "audio") {
          audio += entry.transferred;
          continue;
        }
        transferred += entry.transferred;
        kinds[kind] = (kinds[kind] || 0) + entry.transferred;
        if (kind === "script") scripts.push({ file: new URL(entry.url).pathname, transferred: entry.transferred, size: entry.size, cached: entry.cached });
      }
      return { transferred, audio, kinds, scripts };
    },
  };
}

// ---- One run ---------------------------------------------------------------------------------------------------

async function openOnce(page, network, book, phase) {
  // The Library first, as the app starts: opening Read is then what a tap on the book's Read does.
  await page.goto(`${origin}/#library`, { waitUntil: "load" });
  await page.locator("nav[aria-label='Main']").first().waitFor({ state: "visible", timeout: 60_000 });
  await network.quiet();
  network.phase(phase);
  await page.evaluate((workId) => window.__readerMeasure.open(workId), book.ebook.workId);
  await page.waitForFunction(() => window.__readerMeasure.state.marks.place != null, null, { timeout: OPEN_TIMEOUT, polling: 100 }).catch(async () => {
    const shot = path.join("artifacts", `reader-open-failed-${book.label}.png`);
    fs.mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: shot }).catch(() => {});
    const seen = await page.evaluate(() => ({ address: location.hash, room: document.querySelector(".inline-reader")?.innerText.slice(0, 300) ?? null, marks: window.__readerMeasure.state.marks }));
    throw new Error(`${book.label}: the reader showed no text in ${OPEN_TIMEOUT / 1000} s (${JSON.stringify(seen)}; screenshot ${shot})`);
  });
  // Following starts by itself where the saved listening place is narrated; a place the map does not cover never does.
  await page.waitForFunction(() => window.__readerMeasure.state.marks.follow != null, null, { timeout: FOLLOW_TIMEOUT, polling: 100 }).catch(() => {});
  await network.quiet(OPEN_TIMEOUT);
  const opened = await page.evaluate(() => ({
    marks: window.__readerMeasure.state.marks,
    ebook: document.querySelector(".inline-reader")?.getAttribute("data-ebook") ?? null,
    frames: document.querySelectorAll(".inline-reader .reader-viewport iframe").length,
  }));
  if (opened.ebook !== book.ebook.id) throw new Error(`Read opened EPUB ${opened.ebook}, not ${book.ebook.id}`);
  network.phase("after");
  return { ...opened.marks, frames: opened.frames, ...network.summary(phase) };
}

/** Seeks the paused narration to the middle of the loaded file's map and times the reader showing that sentence. */
async function jumpOnce(page, book) {
  const source = await page.evaluate(() => window.__readerMeasure.audio()?.src ?? null);
  const track = source && book.book.tracks.find((entry) => source.includes(encodeURIComponent(entry.id)) || source.includes(entry.id));
  if (!track) return { jump: null, jumpNote: "no narration loaded" };
  const current = await page.evaluate(() => document.querySelector(".inline-reader")?.getAttribute("data-current-passage") ?? null);
  const onTrack = book.job.intervals.filter((entry) => entry.trackId === track.id && entry.end - entry.start > 4);
  // The middle of the loaded file's map, or its last quarter when the reader is already there.
  let target = onTrack[onTrack.length >> 1];
  if (target && target.paragraphId === current) target = onTrack[(onTrack.length * 3) >> 2];
  if (!target || target.paragraphId === current) return { jump: null, jumpNote: "no other narrated passage on the loaded file" };
  await page.evaluate(({ position, passage }) => window.__readerMeasure.jump(position, passage), { position: intervalMiddle(target), passage: target.paragraphId });
  const done = await page
    .waitForFunction(() => window.__readerMeasure.state.jump.done, null, { timeout: OPEN_TIMEOUT, polling: 100 })
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  return { jump: done, jumpNote: done == null ? "the reader did not show the passage" : null };
}

async function run(browser, cookies, profileName, book) {
  const profile = PROFILES[profileName];
  const context = await browser.newContext({ ...profile.context, baseURL: origin, serviceWorkers: "block" });
  const errors = [];
  try {
    await context.addCookies(cookies);
    await context.addInitScript(instrument, { origin, choices: { [book.ebook.workId]: book.ebook.id } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const session = await context.newCDPSession(page);
    const network = await watchNetwork(session);
    if (profile.cpu > 1) await session.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    if (profile.network) await session.send("Network.emulateNetworkConditions", profile.network);
    // Cold: a browser that has never opened the app. The shell loads first and is counted apart.
    const cold = await openOnce(page, network, book, "cold");
    const shell = network.summary("shell");
    // Warm: the same browser after a reload, so the scripts are in its cache and the EPUB is on the device.
    network.phase("reload");
    const warm = await openOnce(page, network, book, "warm");
    const jump = await jumpOnce(page, book);
    const writes = await page.evaluate(() => window.__readerMeasure.writes);
    return { cold, warm, shell, ...jump, writes, errors };
  } finally {
    await context.close();
  }
}

// ---- All of it -------------------------------------------------------------------------------------------------

const kb = (bytes) => (bytes == null ? "–" : `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`);
const ms = (value) => (value == null ? "–" : `${Math.round(value).toLocaleString("en-US")} ms`);

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/home/jahn/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome" });
const report = { measuredAt: new Date().toISOString(), target: origin, build: null, runs: RUNS, profiles: PROFILE_NAMES, books: [], results: [] };
try {
  const signIn = await browser.newContext({ baseURL: origin });
  if (process.env.APP_PASSWORD) {
    const login = await signIn.request.post("/api/auth/login", { data: { password: process.env.APP_PASSWORD } });
    if (!login.ok()) throw new Error(`Sign-in failed (POST /api/auth/login answered ${login.status()})`);
  }
  report.build = (await (await signIn.request.get("/build.json")).json().catch(() => null))?.id ?? null;
  const lib = await library(signIn.request);
  const books = await chooseBooks(candidates(lib), lib.read);
  for (const book of books) {
    const text = book.text ?? (await lib.read(`/api/reader/${encodeURIComponent(book.ebook.id)}`));
    const sentences = text.sections.reduce((count, section) => count + section.paragraphs.length, 0);
    report.books.push({ label: book.label, ebookId: book.ebook.id, recordingId: book.job.recordingId, fileBytes: book.ebook.size, sections: text.sections.length, sentences, characters: characters(text), mapped: book.job.intervals.length });
  }
  console.log(`--books ${books.map((book) => `${book.label}=${book.ebook.id}`).join(",")}`);
  const cookies = await signIn.cookies();
  await signIn.close();
  for (const book of books)
    for (const profileName of PROFILE_NAMES) {
      const runs = [];
      for (let index = 0; index < RUNS; index++) {
        const result = await run(browser, cookies, profileName, book);
        runs.push(result);
        console.error(`${book.label} ${profileName} run ${index + 1}: cold ${ms(result.cold.text)} / ${ms(result.cold.place)} / ${ms(result.cold.follow)}, warm ${ms(result.warm.text)} / ${ms(result.warm.place)} / ${ms(result.warm.follow)}, jump ${ms(result.jump)}`);
      }
      const row = (state) => ({
        text: median(runs.map((entry) => entry[state].text)),
        place: median(runs.map((entry) => entry[state].place)),
        follow: median(runs.map((entry) => entry[state].follow)),
        transferred: median(runs.map((entry) => entry[state].transferred)),
        kinds: runs[0][state].kinds,
        scripts: runs[0][state].scripts,
        frames: runs[0][state].frames,
      });
      report.results.push({
        book: book.label,
        profile: profileName,
        cold: row("cold"),
        warm: row("warm"),
        shell: { transferred: median(runs.map((entry) => entry.shell.transferred)), scripts: runs[0].shell.scripts },
        jump: median(runs.map((entry) => entry.jump)),
        jumpNote: runs.find((entry) => entry.jumpNote)?.jumpNote ?? null,
        blockedWrites: [...new Set(runs.flatMap((entry) => entry.writes.filter((write) => !write.answered).map((write) => `${write.method} ${write.path}`)))],
        pageErrors: [...new Set(runs.flatMap((entry) => entry.errors))],
        runs,
      });
    }
} finally {
  await browser.close();
}

const out = option("out", path.join("artifacts", `reader-open-${report.measuredAt.replace(/[:.]/g, "-")}.json`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 1));

console.log(`\nBuild ${report.build}, median of ${RUNS} runs. Times from opening Read; bytes over the wire without audio.\n`);
console.log("| Book | EPUB | Sentences | Profile | State | First text | Place shown | Following | Bytes | Scripts loaded (unpacked) |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const result of report.results) {
  const book = report.books.find((entry) => entry.label === result.book);
  for (const state of ["cold", "warm"]) {
    const row = result[state];
    const scripts = row.scripts.reduce((sum, script) => sum + script.size, 0);
    console.log(`| ${result.book} | ${kb(book.fileBytes)} | ${book.sentences.toLocaleString("en-US")} | ${result.profile} | ${state} | ${ms(row.text)} | ${ms(row.place)} | ${ms(row.follow)} | ${kb(row.transferred)} | ${row.scripts.length} (${kb(scripts)}) |`);
  }
}
console.log("\n| Book | Profile | Jump to a narrated place | App shell, first visit |");
console.log("| --- | --- | --- | --- |");
for (const result of report.results) console.log(`| ${result.book} | ${result.profile} | ${ms(result.jump)}${result.jumpNote ? ` (${result.jumpNote})` : ""} | ${kb(result.shell.transferred)} |`);
const blocked = [...new Set(report.results.flatMap((result) => result.blockedWrites))];
if (blocked.length) console.log(`\nWrites the page tried that the measurement does not know: ${blocked.join(", ")}`);
const errors = [...new Set(report.results.flatMap((result) => result.pageErrors))];
if (errors.length) console.log(`\nPage errors: ${errors.join(" | ")}`);
console.log(`\nReport: ${out}`);
