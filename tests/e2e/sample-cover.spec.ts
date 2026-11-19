// #763: an edition without its own cover never shows a sample book's art. With the owner's data shape (a work with
// one covered and two uncovered editions; a catalogue placeholder with no cover anywhere), on a server of the test's
// own so no other spec's books or places are in the way.
import { test, expect } from "./own-server";
import { mkdirSync } from "node:fs";
import { COVER_SHAPE_FIXTURE, COVER_SHAPE_IMAGE } from "../cover-fixture-routes";
import { chooseView } from "./library-view";

test.use({ serviceWorkers: "block" });

const shot = (name: string) => {
  mkdirSync("artifacts", { recursive: true });
  return `artifacts/763-${name}-${test.info().project.name}.png`;
};

test("the mini player, Now playing and the Library show the work's cover or the generated one, never a sample book's", async ({ page }) => {
  expect((await page.request.post(COVER_SHAPE_FIXTURE, { data: {} })).ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library", exact: true, level: 1 })).toBeVisible();

  // The mini player shows the edition with the newest place: TorBox's, stored with The Time Machine's art.
  const dock = page.locator(".player-dock");
  await expect(dock.locator(".dock-book strong")).toHaveText("A Game of Thrones");
  const dockCover = dock.locator(".dock-cover-button img");
  await expect(dockCover).toHaveAttribute("src", COVER_SHAPE_IMAGE);
  await expect.poll(() => dockCover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2);

  // The Library's tiles: the work's cover, and the generated cover (title and author) for a book with none anywhere.
  await chooseView(page, "Grid");
  // The sample books themselves keep their own art: only theirs is drawn from /covers/.
  for (const sample of await page.locator('img[src^="/covers/"]').all())
    expect(await sample.evaluate((img) => img.closest(".library-tile")?.getAttribute("data-work") ?? "")).toMatch(/^work-(?:alice|sherlock|pride|frankenstein|time|meditations|gatsby|war)$/);
  const tile = (workId: string) => page.locator(`.library-tile[data-work="${workId}"] .library-cover`);
  await expect(tile("w-got-763").locator("img")).toHaveAttribute("src", COVER_SHAPE_IMAGE);
  const generated = tile("w-dw-763").locator(".part-cover");
  await expect(generated).toBeVisible();
  // The words are drawn, not DOM text (#763's fix round): no getByText match and nothing in the accessibility tree,
  // so a page's own title stays the one element with the book's name.
  const drawn = (part: string) =>
    generated.locator(part).evaluate((el) => ({
      text: el.textContent,
      // The drawn words, without the alternative text after "/" (empty, so nothing is read out) where it is reported.
      drawn: getComputedStyle(el, "::before").content.replace(/ \/ ""$/, ""),
      height: el.getBoundingClientRect().height,
    }));
  expect(await drawn(".part-cover-title")).toEqual({ text: "", drawn: '"Dangerous Women"', height: expect.any(Number) });
  expect(await drawn(".part-cover-author")).toEqual({ text: "", drawn: '"George R.R. Martin"', height: expect.any(Number) });
  expect((await drawn(".part-cover-title")).height).toBeGreaterThan(10);
  expect((await drawn(".part-cover-author")).height).toBeGreaterThan(10);
  await expect(tile("w-dw-763").getByText("Dangerous Women")).toHaveCount(0);
  await expect(tile("w-dw-763").getByText("George R.R. Martin")).toHaveCount(0);
  expect(await generated.getAttribute("aria-hidden")).toBe("true");
  await expect(tile("w-dw-763").locator("img")).toHaveCount(0);
  const box = await generated.boundingBox();
  expect(box && box.width > 40 && Math.abs(box.width - box.height) < 2).toBe(true);
  await page.screenshot({ path: shot("phone-library") });

  // Now playing, from the mini player.
  await dock.locator(".dock-book").click();
  const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(nowPlaying).toBeVisible();
  await expect(nowPlaying.locator("img.now-playing-cover")).toHaveAttribute("src", COVER_SHAPE_IMAGE);
  await page.screenshot({ path: shot("phone-now-playing") });
  await page.goBack();
  await expect(nowPlaying).toBeHidden();

  // The desktop footer is the same dock at a desktop width.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(dock.locator(".dock-cover-button img")).toHaveAttribute("src", COVER_SHAPE_IMAGE);
  await expect(tile("w-dw-763").locator(".part-cover")).toBeVisible();
  await page.screenshot({ path: shot("desktop-library") });
});
