// @projects firefox
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { longBookFixture } from "../long-book-fixture";
import { gotoRead } from "./read-face";
import { choosePreparedView } from "./prepared-view";
// Pages mode in the new reading view, walked at random (#803). Three reviews each found a fault on a path no test
// had walked (back across several parts and forward again, the book's first page reached backwards). So this spec
// does not name paths: it takes seeded random walks of turns back and forward, long enough to cross several part
// joints each way and to have parts taken out on both sides of the reader, and after every turn holds the page to
// what must be true of every page:
//
//   it has text;
//   it joins the page before it: no sentence left out between them, no line of the one shown again on the other;
//   no line is cut by an edge of the band;
//   it does not change while it is shown (parts come and go around it);
//   turning back to a page shows that page again, line for line, however long ago it was read.
//
// A walk is legs of turns one way and then the other, each some parts long, with a few turns against the leg and
// back now and then; it goes on past the turns it was given, leg by leg, until it has crossed joints both ways and
// had parts taken out on both sides. It reports every fault it met, with its seed and turn. A seed that fails is kept
// with its book as a case of its own.
//
// In the suite it is four short walks (one page and two, a book of each kind) in a very tall band, where a part is a
// few pages, so that some eighty turns cross several joints each way: about two minutes a browser. The long walk is
// run by hand (README, "The new reading view"): `SONDER_WALK=long` walks the whole book backwards and forwards
// again and every seed kept here, 16 parts' worth of turns each, in a band of a desktop's height, about 25 minutes a
// browser. `SONDER_WALK_SEEDS=7,8` walks other seeds, `SONDER_WALK_PARTS` sets how many parts' worth of turns a walk
// takes, `SONDER_WALK_BAND=390x844` the window it walks in (a phone's, where a part has many times the pages).
test.use({ serviceWorkers: "block" });

const asked = process.env.SONDER_WALK_SEEDS ? process.env.SONDER_WALK_SEEDS.split(",").map(Number) : null;

const imported: string[] = [];
let appearance: any = null;
test.beforeEach(async ({ page }) => {
  appearance = await (await page.request.get("/api/appearance")).json();
  expect((await page.request.put("/api/appearance", { data: { ...appearance, reader: { ...appearance.reader, mode: "paginated" } } })).ok()).toBe(true);
  await page.addInitScript(() => localStorage.setItem("sonder-follow-narration", "off"));
  await choosePreparedView(page);
});
test.afterEach(async ({ page }) => {
  if (appearance) await page.request.put("/api/appearance", { data: appearance });
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
});

const band = (page: Page) => page.locator(".reader-room .reader-viewport");
type Shown = { ids: string[]; lines: string[]; key: string; cut: number; parts: string; pages: string | null; box: { x: number; y: number; width: number; height: number } };
/** The page shown: its sentences in order, each line box of theirs with its place, and the lines an edge cuts. */
const pageOf = (page: Page): Promise<Shown> =>
  band(page).evaluate((host) => {
    const box = host.getBoundingClientRect();
    const lines: string[] = [];
    const ids: string[] = [];
    let cut = 0;
    // The sentences stand in the columns in their order, so the first one on the page is found by halving; the
    // read begins a little before it and ends with the first sentence wholly beyond the band.
    const spans = Array.from(host.querySelectorAll<HTMLElement>(".prepared-text [data-s]"));
    let low = 0, high = spans.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (spans[middle]!.getBoundingClientRect().right <= box.left + 1) low = middle + 1;
      else high = middle;
    }
    for (let at = Math.max(0, low - 40); at < spans.length; at++) {
      const span = spans[at]!;
      const whole = span.getBoundingClientRect();
      if (whole.width >= 1 && whole.left >= box.right - 1) break;
      for (const rect of span.getClientRects()) {
        if (rect.width < 1 || rect.right <= box.left + 1 || rect.left >= box.right - 1 || rect.bottom <= box.top + 1 || rect.top >= box.bottom - 1) continue;
        // A line's box reaches a little over the lines above and below it: cut is a line whose middle is outside
        // the band, or whose box an edge at the side runs through.
        const middle = (rect.top + rect.bottom) / 2;
        if (middle <= box.top || middle >= box.bottom || rect.left < box.left - 0.5 || rect.right > box.right + 0.5) {
          cut++;
          continue;
        }
        const id = span.getAttribute("data-s")!;
        if (ids.at(-1) !== id) ids.push(id);
        lines.push(`${id}@${Math.round(rect.left - box.left)},${Math.round(rect.top - box.top)},${Math.round(rect.width)}`);
      }
    }
    return { ids, lines, key: lines.join("|"), cut, parts: host.getAttribute("data-parts") ?? "", pages: host.getAttribute("data-pages"), box: { x: box.x, y: box.y, width: box.width, height: box.height } };
  });
/** The page once two reads a moment apart agree: parts that were on their way are in, or out. */
const settled = async (page: Page) => {
  let before = await pageOf(page);
  for (let tries = 0; tries < 40; tries++) {
    await page.waitForTimeout(60);
    const now = await pageOf(page);
    if (now.key === before.key && now.parts === before.parts) return now;
    before = now;
  }
  return before;
};
/** A small seeded generator (mulberry32): the same seed walks the same way on every host. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const long = process.env.SONDER_WALK === "long";
type Book = { name: string; chapters: number; each: number; seeds: number[]; suite: Record<string, number>; whole?: boolean };
const BOOKS: Book[] = [
  // Its parts begin inside a chapter: nothing of the book's own stands between two parts.
  // Seed 20 goes back to the book's first page, on through six parts, back and on again; seed 17 on through three
  // parts, back to the book's first page and on through five. Both failed on the design before this one, in which
  // a part's place depended on the parts before it (sentences shown again where a part was taken out behind a
  // reader who had come backwards, a page with no text, the book's first page reached backwards).
  // And one walk that is not random, the path a review found faults on: opened in the last part, back to the book's
  // first page across every joint, and forward again to the end (seed 0).
  { name: "a book whose parts begin inside a chapter", chapters: 4, each: 4000, seeds: [20, 17], suite: { "one page": 20, "two pages": 17 }, whole: true },
  // Its parts begin at chapters. Seed 37 goes on through three parts, back to the book's start and on through six.
  { name: "a book of short chapters", chapters: 30, each: 600, seeds: [37], suite: { "one page": 37, "two pages": 37 } },
];
// Tall bands: few pages to a part, so a walk crosses many parts in the turns it has, and up to five parts are in the
// page at once. The suite's are taller still.
const LAYOUTS = [
  { name: "one page", viewport: { width: 700, height: long ? 2400 : 8000 }, pages: "1" },
  { name: "two pages", viewport: { width: 1920, height: long ? 2000 : 6000 }, pages: "2" },
] as const;
/** How many parts' worth of turns a walk takes. */
const PARTS_WALKED = Number(process.env.SONDER_WALK_PARTS) || (long ? 16 : 14);

for (const book of BOOKS)
  for (const layout of LAYOUTS)
    for (const seed of asked ?? (long ? [...(book.whole ? [0] : []), ...book.seeds] : [book.suite[layout.name]!]))
      test(`${seed ? `a random walk of turns, seed ${seed}` : "the whole book backwards and forwards again"}, ${layout.name}, ${book.name}: every page has text, joins its neighbours, is cut nowhere and comes again as it was`, async ({ page }) => {
        test.setTimeout(process.env.SONDER_WALK_BAND || process.env.SONDER_WALK_PARTS ? 3600000 : long ? 900000 : 180000);
        // `SONDER_WALK_BAND=390x844` walks in another window (a phone's, where a part has four times the pages).
        const [wide, high] = (process.env.SONDER_WALK_BAND || "").split("x").map(Number);
        await page.setViewportSize(wide && high ? { width: wide, height: high } : layout.viewport);
        const title = `Walk ${randomUUID()}`;
        const uploaded = await page.request.post("/api/ebooks/import", { multipart: { file: { name: "Walk.epub", mimeType: "application/epub+zip", buffer: await longBookFixture({ chapters: book.chapters, sentences: book.each, title }) } } });
        expect(uploaded.ok()).toBe(true);
        const ebook = (await uploaded.json()).id as string;
        const sentences = await (await page.request.get(`/api/reader/${ebook}`)).json();
        imported.push(sentences.workId);
        const manifest = await (await page.request.get(`/api/reader/${ebook}/prepared`)).json();
        const order = new Map<string, number>(sentences.sections.flatMap((section: any) => section.paragraphs.map((paragraph: any) => paragraph.id)).map((id: string, at: number) => [id, at]));
        const last = order.size - 1;
        // The legs have a generator of their own, so a seed walks the same legs in every layout.
        const next = random(seed * 7919 + book.chapters), aside = random(seed * 104729 + 1);
        // Opened near the book's start, so that the walk can reach the book's first page.
        const start = (seed ? manifest.parts[2 + Math.floor(next() * 2)].last : manifest.parts.at(-1).first) as string;
        const section = sentences.sections.find((entry: any) => entry.paragraphs.some((paragraph: any) => paragraph.id === start));
        expect((await page.request.put(`/api/reader/${ebook}/progress`, { data: { locator: { section: section.index, paragraphId: start, quote: section.paragraphs.find((entry: any) => entry.id === start).text, progression: 0.5 }, baseRevision: 0, eventId: `walk-${randomUUID()}`, deviceId: "another-device", updatedAt: Date.now(), origin: "reading" } })).ok()).toBe(true);
        await gotoRead(page, ebook);
        await expect(band(page)).toHaveAttribute("data-mode", "pages");
        await expect.poll(async () => (await pageOf(page)).ids.length, { timeout: 30000 }).toBeGreaterThan(0);
        let shown = await settled(page);
        expect(shown.pages).toBe(layout.pages);

        // Every kind of fault is counted, and its first five cases are told: one fault early in a walk (pages that
        // are not as they were read, from then on) must not hide another kind later in it.
        const faults: string[] = [];
        const kinds = new Map<string, number>();
        const fault = (turn: number, kind: string, what: string) => {
          const met = (kinds.get(kind) ?? 0) + 1;
          kinds.set(kind, met);
          if (met <= 5) faults.push(`seed ${seed}, turn ${turn}: ${kind}: ${what}`);
        };
        /** The pages read, by where they stand from the page opened: a page turned back to is the page that was read. */
        const read = new Map<number, Shown>([[0, shown]]);
        let at = 0, made = 0;
        const joints = { back: 0, forward: 0 }, dropped = { behind: 0, beyond: 0 };
        const ends = (now: Shown) => ({ first: order.get(now.ids[0]!) ?? -1, last: order.get(now.ids.at(-1)!) ?? -1 });
        /** Counts the parts that came into the page and went out of it, from one read of the page to the next. */
        let parts = shown.parts;
        const came = (now: string) => {
          const first = (list: string) => Number(list.split(",")[0]), final = (list: string) => Number(list.split(",").at(-1));
          if (first(now) < first(parts)) joints.back++;
          if (final(now) > final(parts)) joints.forward++;
          if (first(now) > first(parts)) dropped.behind++;
          if (final(now) < final(parts)) dropped.beyond++;
          parts = now;
        };
        /** One turn, and everything that must be true after it. False at the book's first and last page. */
        const turn = async (direction: 1 | -1) => {
          const here = ends(shown);
          if (shown.ids.length && (direction < 0 ? here.first <= 0 : here.last >= last)) return false;
          // The page did not change while it was shown.
          const still = await pageOf(page);
          came(still.parts);
          if (still.key !== shown.key) fault(made, "the page changed while it was shown", `parts ${shown.parts} then ${still.parts}: ${shown.ids[0]}–${shown.ids.at(-1)} then ${still.ids[0]}–${still.ids.at(-1)}`);
          const box = still.box;
          await page.mouse.click(box.x + box.width * (direction > 0 ? 0.92 : 0.08), box.y + box.height / 2);
          let now = still;
          for (let waited = 0; waited < 15000 && now.key === still.key; waited += 25) {
            await page.waitForTimeout(25);
            now = await pageOf(page);
          }
          made++;
          if (now.key === still.key) {
            fault(made, "a turn showed no other page", `${direction > 0 ? "forward" : "back"} from ${still.ids[0]}–${still.ids.at(-1)}, parts ${still.parts}`);
            return false;
          }
          // Parts come in and go out after a turn; the page must stand as it is through that, so it is read at once
          // and again before the next turn.
          came(now.parts);
          const where = `${direction > 0 ? "forward" : "back"}, parts ${still.parts} then ${now.parts}`;
          if (!now.ids.length) fault(made, "a page with no text", `${where}, after ${still.ids.at(-1)}`);
          if (now.cut) fault(made, "lines cut by the band's edge", `${now.cut} (${where})`);
          if (now.ids.length && still.ids.length) {
            const gap = direction > 0 ? ends(now).first - ends(still).last : ends(still).first - ends(now).last;
            if (gap > 1) fault(made, "sentences left out", `${gap - 1} (${where}): ${direction > 0 ? `${still.ids.at(-1)} then ${now.ids[0]}` : `${now.ids.at(-1)} then ${still.ids[0]}`}`);
            if (gap < 0) fault(made, "sentences shown again", `${-gap} (${where}): ${direction > 0 ? `${still.ids.at(-1)} then ${now.ids[0]}` : `${now.ids.at(-1)} then ${still.ids[0]}`}`);
            const again = now.lines.filter((line) => still.lines.includes(line)).length;
            if (again) fault(made, "lines of the page before stand on this one too", `${again} (${where})`);
          }
          if (now.parts.split(",").length > 5) fault(made, "more than five parts in the page", now.parts);
          at += direction;
          const before = read.get(at);
          if (before && before.key !== now.key) fault(made, "the page turned to is not the page that was read there", `${where}: then ${before.ids[0]}–${before.ids.at(-1)}, now ${now.ids[0]}–${now.ids.at(-1)}`);
          if (!before) read.set(at, now);
          shown = now;
          return true;
        };
        // Legs of many turns one way, then the other, each two and a half to six and a half parts long; on the way,
        // now and then a few turns against the leg and back.
        // A part's turns are counted from a full page: the page opened is a part's last, the one before it is full.
        if (seed) await turn(-1);
        const perPart = Math.max(4, Math.round(order.size / manifest.parts.length / Math.max(1, shown.ids.length - 1)));
        if (seed) await turn(1);
        // Seed 0: two legs, each as long as the book.
        const turns = seed ? PARTS_WALKED * perPart : 100000;
        // A walk goes on past its turns, leg by leg, until it is one: until it crossed joints both ways and had parts
        // taken out on both sides (the checks at its end), and at most to three times its turns. Its turns alone do
        // not make sure of that: every part begins on a new page (#803), so a part takes a turn more than its text
        // fills when it ends on a short page, and whether a leg back is long enough for a part to be taken out beyond
        // the reader depends on the band and the style. A walk that has done that ends where its turns end.
        const one = () => joints.back > 1 && joints.forward > 1 && dropped.behind > 0 && dropped.beyond > 0;
        const walking = () => made < turns || (!!seed && !one() && made < 3 * turns);
        let direction: 1 | -1 = !seed || next() < 0.5 ? -1 : 1;
        for (let legs = 0; walking() && (seed || legs < 2); legs++) {
          const leg = seed ? Math.round(perPart * (2.5 + next() * 4)) : 100000;
          let step = 0;
          for (; step < leg && walking(); step++) {
            if (!(await turn(direction))) break;
            if (aside() < 0.03) {
              const far = 1 + Math.floor(aside() * 3);
              let went = 0;
              for (; went < far; went++) if (!(await turn(-direction as 1 | -1))) break;
              for (; went > 0; went--) await turn(direction);
            }
          }
          // A leg that could not begin (the book's end) costs turns too, or the walk would not end.
          if (!step) made += perPart;
          direction = -direction as 1 | -1;
        }
        const counted = [...kinds].map(([kind, met]) => `${kind}: ${met}`);
        console.log(`walk seed ${seed}, ${layout.name}, ${book.name}: ${made} turns over ${read.size} pages, parts came in ${joints.back} times before and ${joints.forward} after the pages loaded, were taken out ${dropped.behind} times behind and ${dropped.beyond} beyond; faults: ${counted.join("; ") || "none"}`);
        expect([...counted, ...faults], `the walk's faults (seed ${seed})`).toEqual([]);
        // The walk was one: it crossed joints both ways and had parts taken out on both sides.
        expect(joints.back, "parts that came in before the run").toBeGreaterThan(1);
        expect(joints.forward, "parts that came in after the run").toBeGreaterThan(1);
        expect(dropped.behind, "parts taken out behind the reader").toBeGreaterThan(0);
        expect(dropped.beyond, "parts taken out beyond the reader").toBeGreaterThan(0);
      });
