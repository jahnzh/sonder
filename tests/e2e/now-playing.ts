// Now playing as one screen with Listen and Read (#593): how the specs reach its faces. The mini player opens it on
// its face rule (Listen the first time, then the face last shown for the work on this device); the head's Listen or
// Read control switches faces. Read's head shows its controls only after a tap in the middle of the text.
import { expect, type Page } from "@playwright/test";

export const nowPlaying = (page: Page) => page.getByRole("dialog", { name: "Now playing", exact: true });
/** The Listen face. */
export const listenFace = (page: Page) => page.locator(".now-playing-listen");
/** The Read face's reader. */
export const readFace = (page: Page) => page.locator(".now-playing-screen .reader-room");

/** Shows the Read face's controls (a tap in the middle of the text); at rest they are hidden. */
export async function showReadControls(page: Page) {
  const topbar = page.locator(".now-playing-screen .reader-topbar");
  if (await topbar.isVisible()) return;
  const text = (await page.locator(".now-playing-screen .reader-viewport").boundingBox())!;
  await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
  await expect(topbar).toBeVisible();
}

/** Opens Now playing from the mini player, on whichever face its rule picks; resolves to that face. */
export async function openNowPlaying(page: Page): Promise<"listen" | "read"> {
  await page.locator(".player-dock .dock-book").click();
  await expect(nowPlaying(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash.split("/")[0])).toMatch(/^#(listen|read)$/);
  return (await page.evaluate(() => location.hash.split("/")[0])) === "#read" ? "read" : "listen";
}

/** Now playing on its Listen face, from the mini player. */
export async function openListen(page: Page) {
  if ((await openNowPlaying(page)) === "read") {
    await expect(page.locator(".now-playing-screen .reader-viewport")).toBeVisible();
    await showReadControls(page);
    await page.locator(".now-playing-screen .reader-topbar").getByRole("radio", { name: "Listen", exact: true }).click();
  }
  await expect(listenFace(page)).toBeVisible();
}

/** Now playing on its Read face, from the mini player: the reader that replaced "Open ebook reader". */
export async function openRead(page: Page) {
  if ((await openNowPlaying(page)) === "listen") {
    await expect(listenFace(page)).toBeVisible();
    await listenFace(page).getByRole("radio", { name: "Read", exact: true }).click();
  }
  await expect(page.locator(".now-playing-screen .reader-viewport")).toBeVisible();
}
