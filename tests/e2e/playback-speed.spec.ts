import { test, expect, type Page } from "@playwright/test";
const serverSpeed = async (page: Page) =>
  (await (await page.request.get("/api/appearance")).json()).playback.speed ??
  null;
async function expectDockSpeed(page: Page, speed: string) {
  await page.locator(".dock-book").click();
  const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(
    nowPlaying.getByRole("button", { name: /^Playback speed/ }).last(),
  ).toHaveText(speed);
  await nowPlaying.getByRole("button", { name: "Close dialog", exact: true }).click();
}
test("the default speed applies once saved, chapter lengths stay real for a book not in the player, and a saved reset clears it", async ({
  page,
}) => {
  const original = await (await page.request.get("/api/appearance")).json();
  // A PUT without a speed keeps the stored one, so cleanup must send null.
  const withSpeed = (speed: number | null) => ({
    ...original,
    playback: { ...original.playback, speed },
  });
  await page.request.put("/api/appearance", { data: withSpeed(null) });
  try {
    await page.goto("/");
    await page
      .locator(".mobile-nav")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await page
      .getByRole("slider", { name: "Default playback speed", exact: true })
      .fill("1.8");
    await expect(page.locator(".setting-range-label output")).toHaveText("1.8×");
    await expectDockSpeed(page, "1×");
    expect(await serverSpeed(page)).toBe(null);
    await page
      .getByRole("button", { name: "Save playback settings", exact: true })
      .click();
    await expect.poll(() => serverSpeed(page)).toBe(1.8);
    await expectDockSpeed(page, "1.8×");
    const dockTitle = await page
      .locator(".player-dock")
      .getByRole("button", { name: /^Open title page for / })
      .getAttribute("aria-label");
    const books: { title: string; inLibrary: boolean; tracks: unknown[] }[] =
      await (await page.request.get("/api/books")).json();
    const otherBook = books.find(
      (book) => book.inLibrary && book.tracks.length > 0 &&
        `Open title page for ${book.title}` !== dockTitle,
    );
    expect(otherBook).toBeDefined();
    await page.locator(".mobile-nav").getByRole("button", { name: "My library", exact: true }).click();
    await page.getByRole("button", { name: `About ${otherBook!.title}`, exact: true }).click();
    const details = page.getByRole("dialog", { name: "Book details", exact: true });
    // Chapter lengths stay real lengths at any speed; only the current chapter's time left is adjusted.
    await expect(
      details.locator(".detail-chapters .chapter-row small").first(),
    ).toHaveAttribute("title", "Chapter length");
    await details.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.locator(".mobile-nav").getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page
      .getByRole("button", { name: "Save appearance", exact: true })
      .click();
    await expect.poll(() => serverSpeed(page)).toBe(null);
    await page.reload();
    await expect(page.locator(".setting-range-label output")).toHaveText("1×");
    await expectDockSpeed(page, "1×");
  } finally {
    await page.request.put("/api/appearance", {
      data: withSpeed(original.playback.speed ?? null),
    });
  }
});
