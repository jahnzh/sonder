// @projects firefox
import { test, expect } from "@playwright/test";
import { LONG_READS, LONG_READS_ONLY, anotherReading, expectJoined, longBook, opened, partsOf, placeAt, settledPage, turn, usePreparedPages, type Shown } from "./prepared-pages";
// Pages mode in the new reading view (#803): the joints between parts, read across both ways, and the rule of pages
// mode, that a part's pages are the same whatever parts are around it.
// Each test opens the book next to the joints it crosses instead of reading to them (#904). The read of the whole
// book backwards across every joint runs only with SONDER_LONG_READS=1, as do a part's pages at a band of a phone's
// or a desktop's height (a part is some fifty pages there; here the band is tall, and a part some seven).
usePreparedPages();

const LAYOUTS = [["one page", { width: 700, height: 1000 }, "1"], ["two pages", { width: 1920, height: 1080 }, "2"]] as const;

// A part is cut by size, so a chapter longer than a part is cut inside: here 12 of 13 parts begin inside a chapter,
// between two paragraphs. Read backwards across such a joint, the page turned to ends where the page left begins,
// with no sentence hidden or shown twice, and forward again is the page that was left, line for line. Three joints:
// the book's first, one in the middle and its last.
for (const [layout, viewport, pages] of LAYOUTS)
  for (const [where, jointOf] of [["first", () => 1], ["middle", (last: number) => Math.round(last / 2)], ["last", (last: number) => last]] as const)
    test(`reading backwards across the ${where} joint of a book whose parts begin inside a chapter, ${layout}: every page ends where the next begins, and forward again is the page that was left`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const { ebook, sentences, manifest, ordinal } = await longBook(page, 4, 4000);
      expect(manifest.parts.length).toBeGreaterThan(8);
      const joint = jointOf(manifest.parts.length - 1);
      // Opened at the part's first page, read on two pages and back to it: the turn across the joint comes in a
      // reading backwards.
      await placeAt(page, ebook, sentences, manifest.parts[joint].first);
      await opened(page, ebook);
      const opening = await settledPage(page);
      expect(opening.pages).toBe(pages);
      expect(opening.ids[0], `part ${joint} begins on a page of its own`).toBe(manifest.parts[joint].first);
      const on = await turn(page, 1);
      expectJoined(opening, on, ordinal, `on from the first page of part ${joint}`);
      await turn(page, 1);
      expect((await turn(page, -1)).lines, `back to the second page of part ${joint}`).toEqual(on.lines);
      const next = await turn(page, -1);
      expect(next.lines, `back to the first page of part ${joint}`).toEqual(opening.lines);
      // The turn across the joint: the last page of the part before, which ends with that part's last sentence.
      const earlier = await turn(page, -1);
      expectJoined(earlier, next, ordinal, `back across the joint into part ${joint - 1}, parts ${next.parts} then ${earlier.parts}`);
      expect(earlier.ids.at(-1), `the last page of part ${joint - 1}`).toBe(manifest.parts[joint - 1].last);
      // Forward again is the page that was left, and back again the page turned to.
      expect((await turn(page, 1)).lines, `forward again after the turn into part ${joint - 1}`).toEqual(next.lines);
      expect((await turn(page, -1)).lines, `and back into part ${joint - 1}`).toEqual(earlier.lines);
      // And on backwards in the part before.
      let shown = earlier;
      for (let step = 0; step < 2; step++) {
        const before = await turn(page, -1);
        expectJoined(before, shown, ordinal, `page ${step} back in part ${joint - 1}`);
        shown = before;
      }
    });

for (const [layout, viewport, pages] of LAYOUTS)
  test(`reading backwards through the whole of a book whose parts begin inside a chapter, ${layout}: every page ends where the next begins, and forward again is the page that was left`, async ({ page }) => {
    test.skip(!LONG_READS, LONG_READS_ONLY);
    if (LONG_READS) test.setTimeout(900000);
    await page.setViewportSize(viewport);
    const { ebook, sentences, manifest, ordinal } = await longBook(page, 4, 4000);
    const last = manifest.parts.length - 1;
    await placeAt(page, ebook, sentences, manifest.parts[last].first);
    await opened(page, ebook);
    let next = await settledPage(page);
    expect(next.pages).toBe(pages);
    let joints = 0, most = 0;
    for (let step = 0; LONG_READS && step < 1500; step++) {
      const earlier = await turn(page, -1);
      expectJoined(earlier, next, ordinal, `turn ${step} back, parts ${next.parts} then ${earlier.parts}`);
      most = Math.max(most, partsOf(earlier).length);
      const ended = manifest.parts.findIndex((part: any) => part.last === earlier.ids.at(-1));
      if (ended >= 0 && next.ids[0] === manifest.parts[ended + 1]?.first) {
        // The turn across a joint: forward again is the page that was left, and back again the page turned to.
        joints++;
        expect((await turn(page, 1)).lines, `forward again after the turn into part ${ended}`).toEqual(next.lines);
        expect((await turn(page, -1)).lines, `and back into part ${ended}`).toEqual(earlier.lines);
      }
      next = earlier;
      if (earlier.parts.split(",")[0] === "0" && earlier.ids.some((id) => ordinal(id) < ordinal(manifest.parts[0].last) - 200)) break;
    }
    expect(joints, "joints between parts crossed backwards").toBe(last);
    expect(most, "parts in the page at once").toBeLessThanOrEqual(5);
  });

// The rule of pages mode: a part's pages depend on that part, the band and the style alone. So the pages of a part
// are the same, line for line, whether the book was opened in that part, the reader came into it reading on from the
// part before, or came back into it from the part after; and with two pages side by side a part begins on a left page.
// In a tall band, where a part is some four pages; SONDER_LONG_READS=1 reads them at a phone's and a desktop's
// height, coming from two parts away.
const SAME = LONG_READS ? LAYOUTS : ([["one page", { width: 700, height: 10000 }, "1"], ["two pages", { width: 1920, height: 5000 }, "2"]] as const);
for (const [layout, viewport, pages] of SAME)
  for (const [kind, chapters, each] of [["begin inside a chapter", 4, 4000], ["begin at chapters", 30, 600]] as const)
    test(`a part's pages are the same whatever parts are around it, ${layout}, parts that ${kind}`, async ({ page: first, browser }) => {
      if (LONG_READS) test.setTimeout(600000);
      await first.setViewportSize(viewport);
      let page = first;
      const { ebook, sentences, manifest, ordinal } = await longBook(page, chapters, each);
      const part = 4, away = LONG_READS ? 2 : 1;
      const from = ordinal(manifest.parts[part].first), to = ordinal(manifest.parts[part].last);
      const inPart = (shown: Shown) => shown.ids.some((id) => ordinal(id) >= from && ordinal(id) <= to);
      /** The part's pages read in one direction from the page shown, in reading order. */
      const read = async (direction: 1 | -1) => {
        const seen: Shown[] = [];
        let shown = await settledPage(page);
        // A part is some four pages here, some fifty in the long reads.
        const most = LONG_READS ? 400 : 20;
        for (let step = 0; step < most && !inPart(shown); step++) shown = await turn(page, direction);
        for (let step = 0; step < most && inPart(shown); step++) {
          seen.push(shown);
          shown = await turn(page, direction);
        }
        return direction > 0 ? seen : seen.reverse();
      };
      // Opened in the part: it is alone in the page at first.
      await placeAt(page, ebook, sentences, manifest.parts[part].first);
      await opened(page, ebook);
      const alone = await read(1);
      expect(alone.length).toBeGreaterThan(2);
      expect(alone[0]!.pages).toBe(pages);
      // A part begins at the top of a page, the left one of two: its first line is the page's first, at the margin.
      expect(alone[0]!.ids[0]).toBe(manifest.parts[part].first);
      const corner = (shown: Shown) => shown.lines[0]!.split("@")[1]!.split(",").map(Number);
      expect(corner(alone[0]!)[0]).toBe(corner(alone[2]!)[0]);
      expect(corner(alone[0]!)[1]).toBeLessThanOrEqual(corner(alone[2]!)[1]!);
      expect(alone.at(-1)!.ids.at(-1)).toBe(manifest.parts[part].last);
      // Read into from the part before, with parts before it in the page.
      page = await anotherReading(browser, viewport, page);
      await placeAt(page, ebook, sentences, manifest.parts[part - away].last);
      await opened(page, ebook);
      const onward = await read(1);
      // Read back into from the part after it, with parts after it in the page.
      page = await anotherReading(browser, viewport, page);
      await placeAt(page, ebook, sentences, manifest.parts[part + away].first);
      await opened(page, ebook);
      const backward = await read(-1);
      expect(onward.length, "pages of the part read into from before").toBe(alone.length);
      expect(backward.length, "pages of the part read back into").toBe(alone.length);
      expect(onward.map((shown) => shown.lines), "read into from before").toEqual(alone.map((shown) => shown.lines));
      expect(backward.map((shown) => shown.lines), "read back into from after").toEqual(alone.map((shown) => shown.lines));
    });
