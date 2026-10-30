import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { readerFixture } from "../reader-fixture";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function fixture(page: Page, title: string) {
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
  const created = await page.request.post("/api/alignments", {
    data: {
      ebookId: ebook,
      recordingId: book.recordingId,
      pairings: manifest.sections.map(
        (section: { index: number }, index: number) => ({
          section: section.index,
          trackId: book.tracks[0].id,
          start: index * 100,
          duration: 95,
        }),
      ),
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
    .toBe(manifest.sections.length);
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
