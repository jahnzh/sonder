// @projects firefox
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

// #721 part e: the match page searches AudiobookDB, Open Library, Google Books and iTunes, one request each, against
// the recorded answers (tests/audiobookdb-fixture.ts). Each group shows as it arrives with its own failure line (Google
// Books fails at the network for "lighthouse"; the iTunes answer is held back in the page), a Google Books or iTunes
// pick links the work beside its main link and fills only what is missing, and each link has its own Unlink.
// At 390 by 844 and at a desktop width.

const OUT = "OUT";
mkdirSync(OUT, { recursive: true });

async function expectLaidOut(page: Page) {
  const shown = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const width = document.documentElement.clientWidth;
    const wide = [...main.querySelectorAll("*")]
      .filter((element) => element.getBoundingClientRect().right > width + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
    return { wide, scrolls: document.documentElement.scrollWidth > width };
  });
  expect(shown.wide, "elements wider than the window").toEqual([]);
  expect(shown.scrolls).toBe(false);
}

async function importBook(page: Page, title: string, author: string) {
  const response = await page.request.post("/api/import", {
    multipart: { title, author, file: { name: "Chapter.mp3", mimeType: "audio/mpeg", buffer: readFileSync("server/demo/alice-01.mp3") } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).id as string;
  const book = (await (await page.request.get("/api/books")).json()).find((entry: { id: string }) => entry.id === id);
  return book.workId as string;
}

for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]] as const) {
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ viewport });

    test("the match page searches all four providers, a group each as it arrives; Google Books and iTunes links beside the main one", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      expect((await page.request.patch("/api/settings", { data: { audiobookdb: "browser-key" } })).ok()).toBe(true);
      const workId = await importBook(page, "The Lighthouse at Noon", "Mira Sand");
      const before = (await (await page.request.get("/api/books")).json()).find((entry: { workId: string }) => entry.workId === workId);
      // iTunes answers only when the test lets it: the other groups must not wait for it.
      let releaseItunes = () => {};
      const itunesHeld = new Promise<void>((resolve) => (releaseItunes = resolve));
      await page.route(/\/api\/catalogue\/search\?.*provider=itunes/, async (route) => {
        await itunesHeld;
        await route.continue();
      });
      await page.goto(`/#book/${encodeURIComponent(workId)}/match`);
      const pageEl = page.getByTestId("match-page");
      await expect(pageEl.getByRole("searchbox", { name: "Search AudiobookDB, Open Library, Google Books and iTunes" })).toHaveValue("The Lighthouse at Noon Mira Sand");
      const group = (provider: string) => pageEl.getByTestId(`match-group-${provider}`);
      await expect(pageEl.locator("[data-testid^=match-group-] h2")).toHaveText(["AudiobookDB", "Open Library", "Google Books", "iTunes"]);
      await expect(group("audiobookdb").getByText("No books found")).toBeVisible();
      await expect(group("openlibrary").getByText("No books found")).toBeVisible();
      await expect(group("googlebooks").getByRole("alert")).toHaveText("Google Books could not be reached (network error).");
      await expect(group("itunes").getByRole("status")).toHaveText("Searching");
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/catalogue-providers-arriving-${size}.png`, fullPage: true });
      releaseItunes();
      const itunes = pageEl.getByRole("radiogroup", { name: "iTunes" });
      await expect(itunes.getByRole("radio", { name: /The Lighthouse at Noon/ })).toBeVisible();
      await expect(itunes.getByRole("radio", { name: /The Lighthouse at Noon/ })).toContainText("Mira Sand · 2023");
      await expect(group("itunes").getByRole("status")).toHaveCount(0);
      await expect(group("googlebooks").getByRole("alert")).toBeVisible();
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/catalogue-providers-search-${size}.png`, fullPage: true });

      // Pick the iTunes audiobook: linked beside the (absent) main link.
      const matchButton = pageEl.getByRole("button", { name: "Match", exact: true });
      await itunes.getByRole("radio", { name: /The Lighthouse at Noon/ }).click();
      await matchButton.click();
      const matched = pageEl.getByRole("list", { name: "Match" });
      await expect(matched.getByText("The Lighthouse at Noon · Mira Sand")).toBeVisible();
      await expect(matched.getByRole("link", { name: "Open on iTunes" })).toHaveAttribute("href", /^https:\/\/books\.apple\.com\/us\/audiobook\/id1500000002$/);
      await expect(matched.getByText("Not matched")).toHaveCount(0);
      await expect(pageEl.getByText("Matched by hand")).toBeVisible();

      // Search again by hand: Google Books answers, its German volume left out; pick it.
      const box = pageEl.getByRole("searchbox", { name: "Search AudiobookDB, Open Library, Google Books and iTunes" });
      await box.fill("Quiet Harbour Mira Sand");
      await box.press("Enter");
      const google = pageEl.getByRole("radiogroup", { name: "Google Books" });
      await expect(google.getByRole("radio", { name: /Quiet Harbour/ })).toBeVisible();
      await expect(google.getByRole("radio"), "the German edition is left out").toHaveCount(1);
      await expect(pageEl.getByRole("radiogroup", { name: "AudiobookDB" }).getByRole("radio", { name: /Quiet Harbour/ })).toBeVisible();
      await google.getByRole("radio", { name: /Quiet Harbour/ }).click();
      await matchButton.click();
      await expect(matched.getByRole("link", { name: "Open on Google Books" })).toHaveAttribute("href", "https://books.google.com/books?id=gbQuiet01");
      await expect(matched.getByRole("link", { name: "Open on iTunes" })).toBeVisible();
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/catalogue-providers-linked-${size}.png`, fullPage: true });

      // Only what is missing was filled: title, author, cover and narrator are the book's own.
      const after = (await (await page.request.get("/api/books")).json()).find((entry: { workId: string }) => entry.workId === workId);
      for (const field of ["title", "author", "cover", "narrator"]) expect(after[field], field).toEqual(before[field]);

      // Each link has its own Unlink: iTunes goes, Google Books stays.
      await matched.getByRole("button", { name: "Unlink iTunes" }).click();
      await expect(matched.getByRole("link", { name: "Open on iTunes" })).toHaveCount(0);
      await expect(matched.getByRole("link", { name: "Open on Google Books" })).toBeVisible();
      await matched.getByRole("button", { name: "Unlink Google Books" }).click();
      await expect(matched.getByText("Not matched")).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}

test("Connections lists Google Books and iTunes as needing no key", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#settings/connections");
  const main = page.locator("main");
  await expect(main.getByRole("list", { name: "Google Books" }).getByText("Not needed")).toBeVisible();
  await expect(main.getByRole("list", { name: "iTunes" }).getByText("Not needed")).toBeVisible();
});
