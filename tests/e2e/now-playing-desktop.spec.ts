// @projects firefox, webkit-iphone-now-playing
// Now playing on a desktop (#595, spec #586 "Desktop"; boards DesktopReader.dc.html, DesktopNowPlaying.dc.html),
// against the suite's own server at 1280 by 800 and at 760, where the desktop's layout starts: Read and Listen
// measured against their boards, the head and the footer in the same place on both faces, no control in two places
// on Listen, nothing over the text (the contents, the footer, the arrows and a docked Appearance; ticket 01's helper),
// and behaviour 12 of the spec's list (taps, page turns and long-press reach the reader, also after a resize and
// with Appearance docked) at a desktop's width. Behaviours 2 and 3 are in now-playing-layout.spec.ts.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readerFixture } from "../reader-fixture";
import { skipOnMobile } from "./mobile";
import { expectTextUncovered, intersects, type Box } from "./reader-bands";

const SIZES = [
  { width: 1280, height: 800 },
  { width: 760, height: 800 },
] as const;

const imported: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of imported.splice(0)) expect((await page.request.delete(`/api/library/${id}`)).ok()).toBe(true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** A book of its own: an audiobook of two files (two chapters) and an EPUB. */
async function book(page: Page, name: string) {
  const title = `${name} ${randomUUID().slice(0, 8)}`;
  const audio = readFileSync("server/demo/alice-01.mp3");
  const response = await page.request.post("/api/import", {
    multipart: {
      title,
      author: "Desktop QA",
      one: { name: "One.mp3", mimeType: "audio/mpeg", buffer: audio },
      two: { name: "Two.mp3", mimeType: "audio/mpeg", buffer: audio },
    } as never,
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as string;
  imported.push(id);
  const entry = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === id);
  const uploaded = await page.request.post(`/api/ebooks/import?workId=${entry.workId}`, {
    multipart: { file: { name: "Desktop.epub", mimeType: "application/epub+zip", buffer: await readerFixture({ title }) } },
  });
  expect(uploaded.ok()).toBe(true);
  return { title, workId: entry.workId as string, ebook: (await uploaded.json()).id as string };
}

const screen = (page: Page) => page.getByRole("dialog", { name: "Now playing", exact: true });
const listen = (page: Page) => page.locator(".now-playing-listen");
const room = (page: Page) => page.locator(".now-playing-screen .reader-room");
const frameText = (page: Page) => page.frameLocator(".now-playing-screen .reader-viewport iframe").getByText("Alice was beginning", { exact: false });

/** getBoundingClientRect: Playwright's boundingBox waits for "stable", which a reflowing EPUB may not reach. */
const rect = async (locator: Locator): Promise<Box> => {
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
};
const near = (actual: number, expected: number, tolerance = 1) =>
  expect(Math.abs(actual - expected), `${actual} is not ${expected}`).toBeLessThanOrEqual(tolerance);
const centreY = (box: Box) => box.y + box.height / 2;

async function openListen(page: Page, workId: string) {
  await page.goto(`/#listen/${workId}`);
  await expect(screen(page)).toBeVisible();
  await expect(listen(page)).toHaveAttribute("data-layout", "desktop");
  await expect(listen(page).getByRole("slider", { name: /^Seek in / })).toBeEnabled();
}
async function openRead(page: Page, workId: string) {
  await page.goto(`/#read/${workId}`);
  await expect(screen(page)).toBeVisible();
  await expect(frameText(page)).toBeVisible();
  await settled(room(page));
}
/** The text band's box stays the same across two reads apart: epub.js is done laying out. */
async function settled(reader: Locator) {
  let previous = "";
  await expect
    .poll(
      async () => {
        const now = JSON.stringify([await reader.locator(".reader-viewport").getAttribute("data-view-resizes"), await rect(reader.locator(".reader-viewport"))]);
        const same = now === previous;
        previous = now;
        return same;
      },
      { intervals: [300] },
    )
    .toBe(true);
}
/** The names of the visible buttons, sliders and groups in `scope`, left to right. */
async function namesLeftToRight(scope: Locator, selector: string) {
  return scope.evaluate((element, selector) => {
    const shown = [...element.querySelectorAll<HTMLElement>(selector)].filter((node) => {
      const style = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && r.width > 0 && r.height > 0;
    });
    return shown
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((node) => node.getAttribute("aria-label") || node.textContent?.trim() || "");
  }, selector);
}
/** The text is covered by none of: the head, the footer, a docked panel (ticket 01's helper), the contents, the arrows. */
async function expectNothingOverText(page: Page) {
  const reader = room(page);
  const boxes = await expectTextUncovered(reader);
  const others: Record<string, Box> = {};
  const contents = reader.locator(".reader-desktop-contents");
  if (await contents.isVisible()) others.contents = await rect(contents);
  for (const name of ["Previous page", "Next page"]) others[name] = await rect(reader.getByRole("button", { name, exact: true }));
  for (const [name, value] of Object.entries(others)) expect(intersects(value, boxes.text), `${name} ${JSON.stringify(value)} intersects the text ${JSON.stringify(boxes.text)}`).toBe(false);
  return boxes;
}
async function checkpointRevision(page: Page, ebook: string) {
  return ((await (await page.request.get(`/api/reader/${ebook}`)).json()).checkpoint?.revision as number | undefined) || 0;
}
/** A point inside a visible line of the shown page, stable across two reads. */
async function sentencePoint(viewport: Locator) {
  let previous: { x: number; y: number } | null = null, found: { x: number; y: number } | null = null;
  await expect
    .poll(async () => {
      const point = await viewport.evaluate((host) => {
        const bounds = host.getBoundingClientRect();
        for (const frame of host.querySelectorAll("iframe")) {
          const doc = frame.contentDocument, at = frame.getBoundingClientRect();
          if (!doc || doc.fonts.status !== "loaded") continue;
          for (const paragraph of doc.querySelectorAll("p")) {
            const range = doc.createRange();
            range.selectNodeContents(paragraph);
            for (const r of range.getClientRects()) {
              const left = Math.max(bounds.left, at.left + r.left), right = Math.min(bounds.right, at.left + r.right);
              const top = Math.max(bounds.top, at.top + r.top), bottom = Math.min(bounds.bottom, at.top + r.bottom);
              if (right - left < 4 || bottom - top < 4) continue;
              const x = (left + right) / 2, y = (top + bottom) / 2;
              const element = doc.elementFromPoint(x - at.left, y - at.top);
              if (document.elementFromPoint(x, y) === frame && element && paragraph.contains(element)) return { x, y };
            }
          }
        }
        return null;
      });
      const same = !!point && !!previous && Math.abs(point.x - previous.x) < 0.5 && Math.abs(point.y - previous.y) < 0.5;
      previous = point;
      if (same) found = point;
      return same;
    })
    .toBe(true);
  return found!;
}
/** A long-press without moving while the button is down: Listen from here, which says something in the footer. */
async function longPress(page: Page) {
  const point = await sentencePoint(room(page).locator(".reader-viewport"));
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  const message = room(page).locator(".reader-player > .reader-message");
  await expect(message).toBeVisible();
  return message;
}

test.beforeEach(() => {
  skipOnMobile(true, "the desktop's layout needs a desktop window, not a phone profile");
});

for (const size of SIZES) {
  test(`Listen at ${size.width} is measured against DesktopNowPlaying.dc.html, each control in one place`, async ({ page }) => {
    await page.setViewportSize(size);
    const { title, workId } = await book(page, "Desktop listen");
    await openListen(page, workId);
    const face = listen(page);
    // The head of 60: Close, Listen or Read after it, the book's page at the end; each 44, 24 from the edges.
    const head = await rect(face.locator(".now-playing-head"));
    expect([head.y, head.height]).toEqual([0, 60]);
    const close = await rect(face.getByRole("button", { name: "Close now playing", exact: true }));
    const faces = await rect(face.getByRole("radiogroup", { name: "Listen or read", exact: true }));
    const bookPage = await rect(face.getByRole("button", { name: "Open this book’s page", exact: true }));
    near(close.x, 24);
    near(faces.x, 24 + 44 + 8);
    near(faces.width, 136);
    near(bookPage.x + bookPage.width, size.width - 24);
    for (const control of [close, faces, bookPage]) {
      near(control.height, 44);
      near(centreY(control), 30);
    }
    // Chapters beside on the left, the current one marked.
    const chapters = face.getByRole("navigation", { name: "Chapters", exact: true });
    const nav = await rect(chapters);
    near(nav.x, 0);
    expect(nav.width).toBeGreaterThanOrEqual(200);
    expect(nav.width).toBeLessThanOrEqual(280);
    await expect(chapters.getByRole("heading", { name: "Chapters", exact: true })).toBeVisible();
    await expect(chapters.getByRole("button")).toHaveCount(2);
    const current = chapters.locator('button[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current.getByRole("img", { name: "Narrating", exact: true })).toBeVisible();
    // The middle: the cover of 200, the book, and the two groups of the phone without Chapters.
    const middle = face.locator(".now-playing-middle");
    const cover = await rect(middle.locator(".now-playing-cover"));
    expect([Math.round(cover.width), Math.round(cover.height)]).toEqual([200, 200]);
    expect(cover.x).toBeGreaterThanOrEqual(nav.x + nav.width);
    await expect(middle.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(middle.getByText("Desktop QA", { exact: true })).toBeVisible();
    await expect(middle.locator(".now-playing-chapter")).toHaveText(/^.+ · \d+ min left in the chapter$/);
    const order = await middle.evaluate((element) =>
      ["Speed", "Sleep timer", "Plays from", "Earlier positions", "Keep on this device"].map((name) => {
        const all = [...element.querySelectorAll("*")];
        return all.findIndex((node) => node.childElementCount === 0 && node.textContent?.trim() === name);
      }),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The footer: the transport and the timeline only, at the bottom, 12 + 44 + 16 and its line.
    const footer = face.locator(".now-playing-footer");
    const foot = await rect(footer);
    near(foot.y + foot.height, size.height);
    near(foot.height, 73);
    expect(await namesLeftToRight(footer, "button, input[type=range]")).toEqual([
      "Rewind 30 seconds",
      expect.stringMatching(/^(Play|Pause)$/),
      "Forward 30 seconds",
      expect.stringMatching(/^Seek in /),
    ]);
    for (const name of ["Rewind 30 seconds", /^(Play|Pause)$/, "Forward 30 seconds"] as const) {
      const control = await rect(footer.getByRole("button", { name, exact: typeof name === "string" }));
      expect([Math.round(control.width), Math.round(control.height)]).toEqual([44, 44]);
      near(centreY(control), centreY(foot), 1.5);
    }
    // No control is in two places: each is shown once on the whole face.
    const once = [
      face.getByRole("button", { name: "Rewind 30 seconds", exact: true }),
      face.getByRole("button", { name: /^(Play|Pause)$/ }),
      face.getByRole("button", { name: "Forward 30 seconds", exact: true }),
      face.getByRole("slider", { name: /^Seek in / }),
      face.getByRole("spinbutton", { name: "Playback speed", exact: true }),
      face.getByRole("button", { name: /^Sleep timer/ }),
      face.getByRole("button", { name: "Plays from", exact: true }),
      face.getByRole("button", { name: "Earlier positions", exact: true }),
      face.getByRole("switch", { name: "Keep on this device", exact: true }),
      face.getByRole("navigation", { name: "Chapters", exact: true }),
    ];
    for (const control of once) await expect(control, `${control}`).toHaveCount(1);
    await expect(face.getByRole("button", { name: /^Chapters/ })).toHaveCount(0);
    await expect(footer.getByRole("button", { name: /^(Sleep timer|Speed)/ })).toHaveCount(0);
    // Nothing of the face overlaps another part: the head, Chapters, the middle and the footer.
    const parts = { head, nav, middle: await rect(middle), foot };
    for (const [a, one] of Object.entries(parts))
      for (const [b, two] of Object.entries(parts)) if (a < b) expect(intersects(one, two), `${a} and ${b}`).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width);
    // A chapter beside moves the narration there and is marked.
    const second = chapters.getByRole("button").nth(1);
    await expect(second).not.toHaveAttribute("aria-current", "true");
    await second.click();
    await expect(second).toHaveAttribute("aria-current", "true");
    await page.screenshot({ path: `artifacts/now-playing-desktop-listen-${size.width}-${test.info().project.name}.png` });
  });

  test(`Read at ${size.width} is measured against DesktopReader.dc.html; switching faces keeps the head and the footer`, async ({ page }) => {
    await page.setViewportSize(size);
    const { workId } = await book(page, "Desktop read");
    await openListen(page, workId);
    const listenHead = await rect(listen(page).locator(".now-playing-head"));
    const listenFoot = await rect(listen(page).locator(".now-playing-footer"));
    const listenClose = await rect(listen(page).getByRole("button", { name: "Close now playing", exact: true }));
    const listenFaces = await rect(listen(page).getByRole("radiogroup", { name: "Listen or read", exact: true }));
    await listen(page).getByRole("radio", { name: "Read", exact: true }).click();
    await expect(frameText(page)).toBeVisible();
    const reader = room(page);
    await settled(reader);
    // The controls always show on a desktop: the head of 60 and the footer are where Listen's were.
    const head = await rect(reader.locator(".reader-head"));
    const foot = await rect(reader.locator(".reader-player"));
    expect(head).toEqual(listenHead);
    expect(foot).toEqual(listenFoot);
    expect(await rect(reader.getByRole("button", { name: "Close reader", exact: true }))).toEqual(listenClose);
    expect(await rect(reader.getByRole("radiogroup", { name: "Listen or read", exact: true }))).toEqual(listenFaces);
    // The head: Close, Listen or Read, "Book · Chapter", then Hide contents, Bookmark, Search, Aa at the end.
    const topbar = reader.locator(".reader-topbar");
    expect(await namesLeftToRight(topbar, "button:not([role=radio]), [role=radiogroup], .reader-topbar-place")).toEqual([
      "Close reader",
      "Listen or read",
      expect.stringMatching(/^Desktop read .+ · .+/),
      "Hide contents",
      "Bookmark current sentence",
      "Search this book",
      "Reader appearance",
    ]);
    const aa = await rect(reader.getByRole("button", { name: "Reader appearance", exact: true }));
    near(aa.x + aa.width, size.width - 24);
    for (const name of ["Close reader", "Hide contents", "Bookmark current sentence", "Search this book", "Reader appearance"]) {
      const control = await rect(reader.getByRole("button", { name, exact: true }));
      expect([Math.round(control.width), Math.round(control.height)]).toEqual([44, 44]);
      near(centreY(control), 30);
    }
    // The contents beside the text, the page arrows in its margins.
    const contents = await rect(reader.getByRole("navigation", { name: "Contents sidebar", exact: true }));
    await expect(reader.getByRole("navigation", { name: "Contents sidebar", exact: true }).getByRole("heading", { name: "Contents" })).toBeVisible();
    near(contents.x, 0);
    const text = await rect(reader.locator(".reader-viewport"));
    expect(text.width).toBeLessThanOrEqual(620.5);
    const previous = await rect(reader.getByRole("button", { name: "Previous page", exact: true }));
    const next = await rect(reader.getByRole("button", { name: "Next page", exact: true }));
    expect(previous.x).toBeGreaterThanOrEqual(contents.x + contents.width);
    near(previous.x + previous.width + 16, text.x);
    near(text.x + text.width + 16, next.x);
    near(centreY(previous), centreY(text), 1.5);
    // The footer: Back to narration, −30, Play or Pause, +30, the timeline, Sleep timer, Speed, on one row.
    expect(await namesLeftToRight(reader.locator(".reader-player"), "button, input[type=range]")).toEqual([
      "Back to narration",
      "Back 30 seconds",
      expect.stringMatching(/^(Play|Pause) narration$/),
      "Forward 30 seconds",
      expect.stringMatching(/^Seek in /),
      expect.stringMatching(/^Sleep timer: /),
      expect.stringMatching(/^Speed [\d.]+ times$/),
    ]);
    const play = await rect(reader.getByRole("button", { name: /^(Play|Pause) narration$/ }));
    for (const name of ["Back to narration", "Back 30 seconds", "Forward 30 seconds", /^Sleep timer: /, /^Speed [\d.]+ times$/] as const) {
      const control = await rect(reader.locator(".reader-player").getByRole("button", { name, exact: typeof name === "string" }));
      expect(control.height).toBeGreaterThanOrEqual(44);
      near(centreY(control), centreY(play), 1.5);
    }
    near(centreY(play), centreY(foot), 1.5);
    await expect(reader.locator(".reader-player").getByRole("button", { name: "Chapters", exact: true })).toBeHidden();
    await expectNothingOverText(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width);
    await page.screenshot({ path: `artifacts/now-playing-desktop-read-${size.width}-${test.info().project.name}.png` });
    // Switching back: the head and the footer stay where they are.
    await reader.getByRole("radio", { name: "Listen", exact: true }).click();
    await expect(listen(page)).toBeVisible();
    expect(await rect(listen(page).locator(".now-playing-head"))).toEqual(head);
    expect(await rect(listen(page).locator(".now-playing-footer"))).toEqual(foot);
  });

  test(`Read at ${size.width}: Hide contents is remembered, Appearance docks in the text's column, Speed opens its setting pop-up above the footer and a message takes the footer's row`, async ({ page }) => {
    await page.setViewportSize(size);
    const { workId } = await book(page, "Desktop dock");
    await openRead(page, workId);
    const reader = room(page);
    const contents = reader.getByRole("navigation", { name: "Contents sidebar", exact: true });
    const hide = reader.getByRole("button", { name: "Hide contents", exact: true });
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    const foot = await rect(reader.locator(".reader-player"));
    // Hide contents: the text takes the room, and the choice is kept on this device across a reload.
    await hide.click();
    await expect(contents).toHaveCount(0);
    await expect(hide).toHaveAttribute("aria-pressed", "false");
    await settled(reader);
    await expectNothingOverText(page);
    await page.reload();
    await expect(frameText(page)).toBeVisible();
    await expect(reader.getByRole("button", { name: "Hide contents", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(contents).toHaveCount(0);
    await reader.getByRole("button", { name: "Hide contents", exact: true }).click();
    await expect(contents).toBeVisible();
    await settled(reader);
    // Appearance docks under the text in the text's column; the footer stays; nothing covers the text.
    await reader.getByRole("button", { name: "Reader appearance", exact: true }).click();
    const panel = reader.locator(".reader-dock > .reader-appearance-dock");
    await expect(panel).toBeVisible();
    await settled(reader);
    const boxes = await expectNothingOverText(page);
    const dock = await rect(panel);
    expect(dock.y).toBeGreaterThanOrEqual(boxes.text.y + boxes.text.height - 0.5);
    near(dock.x, boxes.text.x);
    near(dock.width, boxes.text.width);
    expect(await rect(reader.locator(".reader-player"))).toEqual(foot);
    expect(dock.y + dock.height).toBeLessThanOrEqual(foot.y + 0.5);
    await page.screenshot({ path: `artifacts/now-playing-desktop-appearance-${size.width}-${test.info().project.name}.png` });
    await panel.getByRole("button", { name: /^Close/ }).click();
    await expect(panel).toHaveCount(0);
    await settled(reader);
    // Speed opens its pop-up above its button, standing on the footer's top edge (#890); the footer's controls and
    // the timeline stay, and the footer keeps its box.
    const player = reader.locator(".reader-player");
    const speed = player.getByRole("button", { name: /^Speed [\d.]+ times$/ });
    await speed.click();
    const setting = page.getByRole("group", { name: "Speed", exact: true });
    await expect(setting).toBeVisible();
    await expect(player.getByRole("button", { name: "Back 30 seconds", exact: true })).toBeVisible();
    await expect(player.getByRole("slider", { name: /^Seek in / })).toBeVisible();
    await expect(player.getByRole("button", { name: /^Sleep timer: / })).toBeVisible();
    const row = await rect(setting), speedBox = await rect(speed);
    near(row.y + row.height, foot.y, 1);
    near(row.x + row.width, speedBox.x + speedBox.width, 1);
    expect(await rect(player)).toEqual(foot);
    await expectNothingOverText(page);
    await page.keyboard.press("Escape");
    await expect(setting).toHaveCount(0);
    await expect(speed).toBeFocused();
    // A message takes the footer's row, with Play or Pause at its end; the footer keeps its box.
    const message = await longPress(page);
    const shown = await rect(message);
    near(centreY(shown), centreY(foot), 1.5);
    expect(shown.x).toBeGreaterThanOrEqual(foot.x + 23);
    // The timeline stays beside the message; the row's other controls give way.
    expect(shown.x + shown.width).toBeLessThanOrEqual((await rect(player.getByRole("slider", { name: /^Seek in / }))).x);
    await expect(player.getByRole("button", { name: /^Sleep timer: / })).toBeHidden();
    const messagePlay = await rect(message.getByRole("button", { name: /^(Play|Pause) narration$/ }));
    near(messagePlay.x + messagePlay.width, shown.x + shown.width);
    await expect(player.getByRole("button", { name: "Back 30 seconds", exact: true })).toBeHidden();
    expect(await rect(player)).toEqual(foot);
    await expectNothingOverText(page);
    await page.screenshot({ path: `artifacts/now-playing-desktop-message-${size.width}-${test.info().project.name}.png` });
  });
}

// Behaviour 12 of the spec's list at a desktop's width: taps, page turns and long-press on the book's page reach
// the reader, also after the reader is resized and with Appearance docked.
test("taps, page turns and long-press reach the reader on a desktop, after a resize and with Appearance docked", async ({ page }) => {
  await page.setViewportSize(SIZES[0]);
  const { workId, ebook } = await book(page, "Desktop gestures");
  await openRead(page, workId);
  const reader = room(page);
  const topbar = reader.locator(".reader-topbar");
  let text = await rect(reader.locator(".reader-viewport"));
  // A tap in the middle reaches the reader and hides nothing: a desktop always shows its controls.
  await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
  await expect(topbar).toBeVisible();
  await expect(reader.locator(".reader-player").getByRole("button", { name: "Back 30 seconds", exact: true })).toBeVisible();
  // A tap on the right third turns the page, which saves a reading checkpoint; so does the Next page arrow.
  let revision = await checkpointRevision(page, ebook);
  await page.mouse.click(text.x + text.width * 0.9, text.y + text.height / 2);
  await expect.poll(() => checkpointRevision(page, ebook)).toBeGreaterThan(revision);
  revision = await checkpointRevision(page, ebook);
  await reader.getByRole("button", { name: "Next page", exact: true }).click();
  await expect.poll(() => checkpointRevision(page, ebook)).toBeGreaterThan(revision);
  // The long-press listens from the sentence: its message is in the footer.
  await longPress(page);
  await reader.locator(".reader-player > .reader-message").getByRole("button", { name: "Dismiss", exact: true }).or(
    reader.locator(".reader-player > .reader-message").getByRole("button", { name: "Undo", exact: true }),
  ).first().click();
  await expect(reader.locator(".reader-player > .reader-message")).toHaveCount(0);
  // Resized to the desktop's narrowest: the band changed, and a tap on the right third and a long-press still reach.
  await page.setViewportSize(SIZES[1]);
  await expect.poll(async () => (await rect(reader.locator(".reader-viewport"))).width).toBeLessThan(text.width - 50);
  await settled(reader);
  text = await rect(reader.locator(".reader-viewport"));
  revision = await checkpointRevision(page, ebook);
  await page.mouse.click(text.x + text.width * 0.9, text.y + text.height / 2);
  await expect.poll(() => checkpointRevision(page, ebook)).toBeGreaterThan(revision);
  await longPress(page);
  await reader.locator(".reader-player > .reader-message").getByRole("button", { name: "Dismiss", exact: true }).or(
    reader.locator(".reader-player > .reader-message").getByRole("button", { name: "Undo", exact: true }),
  ).first().click();
  // With Appearance docked the band is shorter; the page turn and the long-press still reach the reader.
  await reader.getByRole("button", { name: "Reader appearance", exact: true }).click();
  await expect(reader.locator(".reader-dock > .reader-appearance-dock")).toBeVisible();
  await expect.poll(async () => (await rect(reader.locator(".reader-viewport"))).height).toBeLessThan(text.height - 50);
  await settled(reader);
  text = await rect(reader.locator(".reader-viewport"));
  revision = await checkpointRevision(page, ebook);
  await page.mouse.click(text.x + text.width * 0.9, text.y + text.height / 2);
  await expect.poll(() => checkpointRevision(page, ebook)).toBeGreaterThan(revision);
  await longPress(page);
  await expectNothingOverText(page);
});
