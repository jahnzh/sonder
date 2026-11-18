// Now playing on a desktop (#595, spec #586 "Desktop"), with plain data: the width it starts at, Listen's chapter line
// under the author (DesktopNowPlaying.dc.html), and where each of Listen's controls is, so none is in two places.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_MIN_WIDTH, DESKTOP_QUERY, listenChapterLine, listenPlaces } from "../src/now-playing-desktop.ts";

test("the desktop starts at 760 px, the plan's width", () => {
  assert.equal(DESKTOP_MIN_WIDTH, 760);
  assert.equal(DESKTOP_QUERY, "(min-width: 760px)");
});

test("Listen's chapter line names the chapter and its whole minutes left, rounded up", () => {
  assert.equal(listenChapterLine("Letter 1", 240), "Letter 1 · 4 min left in the chapter");
  assert.equal(listenChapterLine("Letter 1", 241), "Letter 1 · 5 min left in the chapter");
  // Seconds left never say 0 minutes; the end of the chapter says 1.
  assert.equal(listenChapterLine("Letter 1", 5), "Letter 1 · 1 min left in the chapter");
  assert.equal(listenChapterLine("Letter 1", 0), "Letter 1 · 1 min left in the chapter");
  assert.equal(listenChapterLine("  Letter 1 ", 60), "Letter 1 · 1 min left in the chapter");
});

test("without a time left the line is the chapter alone; without a chapter there is no line", () => {
  assert.equal(listenChapterLine("Letter 1", null), "Letter 1");
  assert.equal(listenChapterLine("Letter 1", Number.NaN), "Letter 1");
  assert.equal(listenChapterLine("", 120), "");
  assert.equal(listenChapterLine("   ", null), "");
});

test("on a desktop the transport and the timeline are the footer, Chapters the list beside, Speed and Sleep timer rows", () => {
  assert.deepEqual(listenPlaces(true), {
    timeline: "footer",
    transport: "footer",
    speed: "rows",
    sleep: "rows",
    chapters: "beside",
    "plays-from": "rows",
    earlier: "rows",
    keep: "rows",
  });
});

test("on a phone everything is in the middle or the rows, Chapters a row", () => {
  const phone = listenPlaces(false);
  assert.equal(phone.timeline, "middle");
  assert.equal(phone.transport, "middle");
  assert.equal(phone.chapters, "rows");
  assert.ok(!Object.values(phone).includes("footer"));
  assert.ok(!Object.values(phone).includes("beside"));
});
