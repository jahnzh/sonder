import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

test.beforeEach(async ({ page }) => {
  // Lets a test read the audio element the player created.
  await page.addInitScript(() => {
    const elements: HTMLAudioElement[] = [];
    (window as unknown as { __audioElements: HTMLAudioElement[] }).__audioElements = elements;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        elements.push(this);
      }
    };
  });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

/** `align`: every chapter has narration timing, only the first one, or none (a book and an ebook with no map). */
async function fixture(page: Page, title: string, align: "all" | "first" | "none" = "all") {
  const response = await page.request.post("/api/import", {
    multipart: {
      title,
      author: "Word QA",
      file: {
        name: "Narration.mp3",
        mimeType: "audio/mpeg",
        buffer: readFileSync("server/demo/alice-01.mp3"),
      },
    },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id;
  const book = (await (await page.request.get("/api/books")).json()).find(
    (b: { id: string }) => b.id === id,
  );
  const uploaded = await page.request.post(
    `/api/ebooks/import?workId=${book.workId}`,
    {
      multipart: {
        file: {
          name: "Companion.epub",
          mimeType: "application/epub+zip",
          buffer: await readerFixture(),
        },
      },
    },
  );
  expect(uploaded.ok()).toBe(true);
  const ebook = (await uploaded.json()).id;
  const manifest = await (
    await page.request.get(`/api/reader/${ebook}`)
  ).json();
  if (align === "none") return { book, ebook, manifest };
  const sections = align === "first" ? manifest.sections.slice(0, 1) : manifest.sections;
  const created = await page.request.post("/api/alignments", {
    data: {
      ebookId: ebook,
      recordingId: book.recordingId,
      pairings: sections.map((section: { index: number }, index: number) => ({
        section: section.index,
        trackId: book.tracks[0].id,
        start: index * 100,
        duration: 95,
      })),
    },
  });
  expect(created.ok()).toBe(true);
  await expect
    .poll(
      async () => {
        const jobs = (
          await (await page.request.get(`/api/alignments?ebookId=${ebook}`)).json()
        ).jobs;
        return jobs[0]?.sectionsDone.length;
      },
      { timeout: 15000 },
    )
    .toBe(sections.length);
  return { book, ebook, manifest };
}

async function openWordMode(page: Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
  await page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }).click();
  await page.locator(".dock-book").click();
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeVisible();
  const room = page.locator(".inline-reader");
  const topbar = room.locator(".reader-topbar");
  if (await topbar.isHidden()) {
    const box = (await room.locator(".reader-viewport").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(topbar).toBeVisible();
  }
  await room.getByRole("button", { name: "More", exact: true }).click();
  await page
    .locator(".reader-more:visible")
    .getByRole("group", { name: "Reading mode" })
    .getByRole("button", { name: "Word", exact: true })
    .click();
  await expect(page.getByLabel("Word reader")).toBeVisible();
  return room;
}

test("word mode keeps the ORP letter fixed, pauses on tap, steps with arrows, and keeps place in Page mode", async ({
  page,
}) => {
  const { ebook } = await fixture(page, "Word narration");
  const room = await openWordMode(page, "Word narration");
  const reader = page.getByLabel("Word reader");
  await expect(reader).toHaveAttribute("data-paused", "true");

  const orpX = async () => {
    const box = await reader.locator("[data-orp]").boundingBox();
    expect(box).toBeTruthy();
    return box!.x + box!.width / 2;
  };

  // Without narration follow for the WPM path: pause stay, then step short and long words.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const firstWord = await reader.locator("[data-word]").getAttribute("data-word");
  const firstX = await orpX();
  expect(firstWord && firstWord.length).toBeGreaterThan(0);

  // Advance until the shown word length changes, then compare ORP centres.
  let otherWord = firstWord;
  for (let i = 0; i < 12 && otherWord === firstWord; i++) {
    await page.keyboard.press("ArrowRight");
    otherWord = await reader.locator("[data-word]").getAttribute("data-word");
  }
  expect(otherWord).not.toEqual(firstWord);
  const secondX = await orpX();
  expect(Math.abs(secondX - firstX)).toBeLessThan(2);

  const indexBefore = Number(await reader.getAttribute("data-word-index"));
  // Tap the word stage centre so the floating top bar cannot intercept.
  await reader.locator(".word-reader-stage").click();
  await expect(reader).toHaveAttribute("data-paused", "false");
  await reader.locator(".word-reader-stage").click();
  await expect(reader).toHaveAttribute("data-paused", "true");
  await expect(reader.getByTestId("word-context")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  const indexAfter = Number(await reader.getAttribute("data-word-index"));
  expect(indexAfter).toBeGreaterThan(indexBefore);

  // Step a sentence, remember the shown sentence, then switch to Page and back.
  await page.keyboard.press("Shift+ArrowRight");
  await expect(reader).toHaveAttribute("data-paused", "true");
  const context = (await reader.getByTestId("word-context").textContent()) || "";
  expect(context.length).toBeGreaterThan(10);
  const wordIndex = await reader.getAttribute("data-word-index");

  await room.getByRole("button", { name: "More", exact: true }).click();
  await page
    .locator(".reader-more:visible")
    .getByRole("group", { name: "Reading mode" })
    .getByRole("button", { name: "Page", exact: true })
    .click();
  await expect(page.getByLabel("Word reader")).toHaveCount(0);

  await room.getByRole("button", { name: "More", exact: true }).click();
  await page
    .locator(".reader-more:visible")
    .getByRole("group", { name: "Reading mode" })
    .getByRole("button", { name: "Word", exact: true })
    .click();
  const again = page.getByLabel("Word reader");
  await expect(again).toBeVisible();
  // Returning to Word keeps the same sentence (CFI + sentence locator).
  await expect(again.getByTestId("word-context")).toContainText(context.slice(0, 40));
  expect(Number(await again.getAttribute("data-word-index"))).toBeGreaterThanOrEqual(
    Number(wordIndex) - 2,
  );
  void ebook;
});

type Display = "book" | "segment" | "word";

/** The display the reader opens in is a stored preference, so each test sets it first. */
async function setDisplay(page: Page, display: Display) {
  const current = await (await page.request.get("/api/appearance")).json();
  const saved = await page.request.put("/api/appearance", {
    data: { ...current, reader: { ...current.reader, display } },
  });
  expect(saved.ok()).toBe(true);
}

/** Starts the book, pauses it and opens Now Playing, leaving the reader as the stored display has it. */
async function openReader(page: Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Play ${title}`, exact: true }).click();
  await page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await page.locator(".dock-book").click();
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeVisible();
  return page.locator(".inline-reader");
}

async function audioState(page: Page) {
  return page.evaluate(() => {
    const audio = (window as unknown as { __audioElements: HTMLAudioElement[] }).__audioElements.find(
      (element) => !!element.src,
    )!;
    return { position: audio.currentTime, paused: audio.paused };
  });
}

const wordReader = (page: Page) => page.getByLabel("Word reader");
const wordIndex = async (page: Page) => Number(await wordReader(page).getAttribute("data-word-index"));
const context = async (page: Page) => (await wordReader(page).getByTestId("word-context").textContent()) || "";

test("in Word mode Space and the arrows act once and leave the audiobook alone", async ({ page }) => {
  await fixture(page, "Word keys plain", "none");
  await setDisplay(page, "word");
  await openReader(page, "Word keys plain");
  const reader = wordReader(page);
  await expect(reader).toBeVisible();
  const before = await audioState(page);
  expect(before.paused).toBe(true);

  // No narration is mapped, so Space runs the words, not the audiobook.
  await page.keyboard.press("Space");
  await expect(reader).toHaveAttribute("data-paused", "false");
  expect((await audioState(page)).paused).toBe(true);
  await page.keyboard.press("Space");
  await expect(reader).toHaveAttribute("data-paused", "true");
  expect((await audioState(page)).paused).toBe(true);

  // Arrows step words; the audio does not skip 30 seconds.
  const index = await wordIndex(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(reader).toHaveAttribute("data-word-index", String(index + 3));
  await page.keyboard.press("ArrowLeft");
  await expect(reader).toHaveAttribute("data-word-index", String(index + 2));
  await page.keyboard.press("Shift+ArrowRight");
  await expect(reader).not.toHaveAttribute("data-word-index", String(index + 2));
  const after = await audioState(page);
  expect(after.paused).toBe(true);
  expect(after.position).toBe(before.position);

  // A held key steps once.
  const held = await wordIndex(page);
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.up("ArrowRight");
  await expect(reader).toHaveAttribute("data-word-index", String(held + 1));
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");
  await expect(reader).toHaveAttribute("data-paused", "false");
  await page.keyboard.press("Space");
  await expect(reader).toHaveAttribute("data-paused", "true");
});

test("with narration Space toggles the audio once and the arrows do not skip 30 seconds", async ({ page }) => {
  await fixture(page, "Word keys narrated");
  await setDisplay(page, "word");
  await openReader(page, "Word keys narrated");
  const reader = wordReader(page);
  await expect(reader).toBeVisible();
  await expect(reader).toHaveAttribute("data-paused", "true");

  await page.keyboard.press("Space");
  await expect.poll(async () => (await audioState(page)).paused).toBe(false);
  await page.waitForTimeout(400);
  expect((await audioState(page)).paused).toBe(false);
  await page.keyboard.press("Space");
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
  await page.waitForTimeout(400);
  expect((await audioState(page)).paused).toBe(true);

  for (const key of ["ArrowRight", "ArrowRight", "Shift+ArrowRight", "ArrowLeft"]) {
    const { position } = await audioState(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    const moved = await audioState(page);
    expect(Math.abs(moved.position - position), key).toBeLessThan(10);
    expect(moved.paused).toBe(true);
  }
});

test("opened in Word mode with the bar hidden, a touch user reaches the top bar and More", async ({ page }) => {
  await fixture(page, "Word touch");
  await setDisplay(page, "word");
  const room = await openReader(page, "Word touch");
  const reader = wordReader(page);
  await expect(reader).toBeVisible();
  const topbar = room.locator(".reader-topbar");
  await expect(topbar).toBeHidden();

  await page.getByRole("button", { name: "Show reader controls", exact: true }).click();
  await expect(topbar).toBeVisible();
  await expect(topbar.getByRole("button", { name: "Close reader", exact: true })).toBeVisible();
  await expect(topbar.getByRole("button", { name: "Bookmark current sentence", exact: true })).toBeVisible();
  await expect(topbar.getByRole("button", { name: "Search this book", exact: true })).toBeVisible();
  await expect(topbar.getByRole("button", { name: "Reader appearance", exact: true })).toBeVisible();
  // The tap on the control did not pause or resume.
  await expect(reader).toHaveAttribute("data-paused", "true");

  await topbar.getByRole("button", { name: "More", exact: true }).click();
  const more = page.locator(".reader-more:visible");
  await expect(more.getByRole("group", { name: "Reading mode" })).toBeVisible();
  await expect(more.getByRole("button", { name: "Listen from here" })).toBeVisible();
  await more.getByRole("group", { name: "Reading mode" }).getByRole("button", { name: "Word", exact: true }).click();

  // And the bar goes away again.
  await page.getByRole("button", { name: "Hide reader controls", exact: true }).click();
  await expect(topbar).toBeHidden();

  // A tap anywhere else still plays and pauses.
  await reader.locator(".word-reader-stage").click();
  await expect(reader).toHaveAttribute("data-paused", "false");
  await reader.locator(".word-reader-stage").click();
  await expect(reader).toHaveAttribute("data-paused", "true");

  // The keys keep working after a click on the control.
  await page.getByRole("button", { name: "Show reader controls", exact: true }).click();
  await page.keyboard.press("Space");
  await expect(reader).toHaveAttribute("data-paused", "false");
  await page.keyboard.press("Space");
  await expect(reader).toHaveAttribute("data-paused", "true");
});

/** Steps sentences in Word mode, then returns the sentence on screen. */
async function stepSentences(page: Page, count: number) {
  // The sentence on screen follows a moment after the key; wait for it before the next press.
  const step = async () => {
    const before = await context(page);
    await page.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => context(page)).not.toBe(before);
  };
  for (let i = 0; i < count; i++) await step();
  // The first sentence of a passage is the only one whose text is unique in the chapter.
  for (let i = 0; i < 3 && !(await context(page)).startsWith("Passage"); i++) await step();
  return context(page);
}

async function expectPageShows(page: Page, sentence: string, notSentence: string) {
  await expect(wordReader(page)).toHaveCount(0);

  const frame = page.frameLocator(".inline-reader .reader-viewport iframe");
  await expect(frame.getByText(sentence.slice(0, 30)).first()).toBeInViewport();
  await expect(frame.getByText(notSentence).first()).not.toBeInViewport();
}

const toPage: [string, (page: Page) => Promise<void>][] = [
  [
    // Its row has no height in the Now Playing layout with a reader, so the click is sent to the element.
    "the player's mode button",
    (page) => page.locator(".player-transport-display button").filter({ hasText: /^Page$/ }).dispatchEvent("click"),
  ],
  ["the p key", (page) => page.keyboard.press("p")],
];
for (const [name, switchToPage] of toPage) {
  test(`switching from Word to Page with ${name} shows the sentence reached`, async ({ page }) => {
    await fixture(page, `Word to page ${name}`, "none");
    await setDisplay(page, "word");
    await openReader(page, `Word to page ${name}`);
    const first = await context(page);
    const sentence = await stepSentences(page, 30);
    expect(sentence).not.toBe(first);
    await switchToPage(page);
    await expectPageShows(page, sentence, first.slice(0, 30));
  });
}

test("switching from Word to Page in Settings shows the sentence reached", async ({ page }) => {
  await fixture(page, "Word to page settings", "none");
  await setDisplay(page, "word");
  await openReader(page, "Word to page settings");
  const first = await context(page);
  const sentence = await stepSentences(page, 30);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeHidden();
  await page.evaluate(() => {
    location.hash = "#settings";
  });
  await page.getByLabel("Ebook view").selectOption("book");
  await page.evaluate(() => {
    location.hash = "#library";
  });
  await page.locator(".dock-book").click();
  await expect(page.getByRole("dialog", { name: "Now playing", exact: true })).toBeVisible();
  await expectPageShows(page, sentence, first.slice(0, 30));
});

test("a checkpoint written in Word mode restores the sentence in Page mode after a reload", async ({ page }) => {
  const { ebook } = await fixture(page, "Word reload", "none");
  await setDisplay(page, "word");
  await openReader(page, "Word reload");
  const first = await context(page);
  const sentence = await stepSentences(page, 30);
  await expect
    .poll(async () => {
      const book = await (await page.request.get(`/api/reader/${ebook}`)).json();
      return book.checkpoint?.locator?.quote?.slice(0, 30);
    })
    .toBe(sentence.slice(0, 30));
  await setDisplay(page, "book");
  await openReader(page, "Word reload");
  await expectPageShows(page, sentence, first.slice(0, 30));
});

test("stepping onto a sentence without timing shows it and saves what is shown", async ({ page }) => {
  const { ebook, manifest } = await fixture(page, "Word unaligned", "first");
  await setDisplay(page, "word");
  await openReader(page, "Word unaligned");
  const reader = wordReader(page);
  await expect(reader).toBeVisible();
  // The last sentence of the narrated chapter, then words onto the next chapter.
  await stepSentences(page, manifest.sections[0].paragraphs.length - 1);
  for (let i = 0; i < 40 && !(await context(page)).includes("second chapter"); i++) {
    await page.keyboard.press("ArrowRight");
  }
  expect(await context(page)).toContain("This is the beginning of the second chapter");
  expect((await audioState(page)).paused).toBe(true);
  await expect
    .poll(async () => {
      const book = await (await page.request.get(`/api/reader/${ebook}`)).json();
      return `${book.checkpoint?.origin}:${book.checkpoint?.locator?.quote?.slice(0, 30)}`;
    })
    .toBe("reading:This is the beginning of the s");
});

test("words advancing by themselves stop in a hidden tab and do not save every sentence", async ({ page }) => {
  const { ebook } = await fixture(page, "Word auto", "none");
  await setDisplay(page, "word");
  await openReader(page, "Word auto");
  const reader = wordReader(page);
  await expect(reader).toBeVisible();
  await reader.getByLabel("Words per minute").fill("900");
  const saves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes(`/api/reader/${ebook}/progress`))
      saves.push(request.url());
  });
  const start = await wordIndex(page);
  await reader.locator(".word-reader-stage").click();
  await expect(reader).toHaveAttribute("data-paused", "false");
  await page.waitForTimeout(6500);
  // Several sentences went by, but not one write for each.
  expect(await wordIndex(page)).toBeGreaterThan(start + 60);
  expect(saves.length).toBeLessThanOrEqual(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(reader).toHaveAttribute("data-paused", "true");
  const stopped = await wordIndex(page);
  await page.waitForTimeout(600);
  expect(await wordIndex(page)).toBe(stopped);
});

