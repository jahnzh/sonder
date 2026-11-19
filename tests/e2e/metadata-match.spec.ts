import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";

// Matching a book's details from a provider (#719 part b), against the recorded provider answers of the browser
// server: on the Edit page, search the four providers, pick a result, and the per-field comparison opens with the
// missing fields ticked ('Fill only what's missing'); a field the book has (its title) is shown unticked and can be
// ticked to overwrite; Apply writes the ticked fields, marked as taken from the provider, and leaves the rest. On the
// Match page, Compare opens the same comparison. At 390 by 844 and at a desktop width.

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

async function search(page: Page, scope: ReturnType<Page["getByTestId"]>) {
  const box = scope.getByRole("searchbox", { name: "Search AudiobookDB, Open Library, Google Books and iTunes" });
  await box.fill("Quiet Harbour Mira Sand");
  await box.press("Enter");
}
const check = (compare: ReturnType<Page["getByTestId"]>, field: string) => compare.getByTestId(`compare-${field}`).getByRole("checkbox");

for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]] as const) {
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ viewport });

    test("the Edit page: search a provider, compare field by field, Apply the ticked fields", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      expect((await page.request.patch("/api/settings", { data: { audiobookdb: "browser-key" } })).ok()).toBe(true);
      const title = `Quiet Harbour ${randomBytes(3).toString("hex")}`;
      const workId = await importBook(page, title, "Mira Sand");
      await page.goto(`/#book/${encodeURIComponent(workId)}/edit`);
      const edit = page.getByTestId("edit-page");
      const matchGroup = edit.getByTestId("edit-match");
      await expect(matchGroup.getByRole("button", { name: "Match automatically", exact: true })).toBeVisible();
      await matchGroup.getByRole("button", { name: "Match from a provider", exact: true }).click();
      await search(page, matchGroup);
      const abdb = matchGroup.getByRole("radiogroup", { name: "AudiobookDB" });
      await abdb.getByRole("radio", { name: /Quiet Harbour/ }).click();
      // No Match button here: the Edit page only compares.
      await expect(matchGroup.getByRole("button", { name: "Match", exact: true })).toHaveCount(0);
      await matchGroup.getByRole("button", { name: "Compare", exact: true }).click();

      const compare = page.getByTestId("metadata-compare");
      await expect(compare.getByText(/^Compare with AudiobookDB · Quiet Harbour$/)).toBeVisible();
      // Missing in the book and given by AudiobookDB: ticked. The title the book has: shown, not ticked. The author is the same.
      await expect(check(compare, "asin")).toBeChecked();
      // The import gave the book a description of its own: not missing, so not ticked.
      await expect(check(compare, "description")).not.toBeChecked();
      await expect(check(compare, "cover")).toBeChecked();
      await expect(check(compare, "title")).not.toBeChecked();
      await expect(check(compare, "title")).toBeEnabled();
      await expect(compare.getByTestId("compare-title")).toContainText(title);
      await expect(check(compare, "authors")).toBeDisabled();
      await expect(compare.getByTestId("compare-authors")).toContainText("Same");
      // Not given by AudiobookDB: nothing to take.
      await expect(check(compare, "genres")).toBeDisabled();
      // The cover is shown by its address.
      await expect(compare.getByTestId("compare-cover").locator("img").last()).toHaveAttribute("src", "https://images.audiobookdb.org/bk-feral.jpg");
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/metadata-compare-${size}.png`, fullPage: true });

      // Take the title too (an overwrite) and leave the description: Apply writes the ticked ones only.
      await check(compare, "title").check();
      const ticked = await compare.getByRole("checkbox", { checked: true }).count();
      await compare.getByRole("button", { name: `Apply · ${ticked}` }).click();
      await expect(compare.getByRole("status").filter({ hasText: /fields? from AudiobookDB$/ })).toBeVisible();
      await expect(edit.getByTestId("edit-title")).toContainText("From AudiobookDB");
      await expect(edit.getByTestId("edit-title").getByRole("textbox")).toHaveValue("Quiet Harbour");
      await expect(edit.getByTestId("edit-asin").getByRole("textbox")).toHaveValue("B0FERAL001");
      await expect(edit.getByTestId("edit-description")).not.toContainText("From AudiobookDB");
      // The library reads the taken values.
      const work = await (await page.request.get(`/api/works/${encodeURIComponent(workId)}`)).json();
      expect(work.title).toBe("Quiet Harbour");
      expect(work.details.asin).toBe("B0FERAL001");
      expect(work.description).not.toContain("The description of Quiet Harbour.");
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/metadata-applied-${size}.png`, fullPage: true });
      expect(errors).toEqual([]);
    });

    test("the Match page: Compare opens the same comparison for the result picked", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      expect((await page.request.patch("/api/settings", { data: { audiobookdb: "browser-key" } })).ok()).toBe(true);
      const workId = await importBook(page, `Quiet Harbour ${randomBytes(3).toString("hex")}`, "Mira Sand");
      await page.goto(`/#book/${encodeURIComponent(workId)}/match`);
      const pageEl = page.getByTestId("match-page");
      await search(page, pageEl);
      await pageEl.getByRole("radiogroup", { name: "Google Books" }).getByRole("radio", { name: /Quiet Harbour/ }).first().click();
      await expect(pageEl.getByRole("button", { name: "Match", exact: true })).toBeEnabled();
      await pageEl.getByRole("button", { name: "Compare", exact: true }).click();
      const compare = page.getByTestId("metadata-compare");
      await expect(compare.getByText(/^Compare with Google Books · Quiet Harbour$/)).toBeVisible();
      await expect(check(compare, "publisher")).toBeChecked();
      await expect(compare.getByTestId("compare-publisher")).toContainText("Harbour Press");
      await expect(check(compare, "isbn")).toBeChecked();
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/metadata-compare-match-page-${size}.png`, fullPage: true });
      await compare.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(compare).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}
