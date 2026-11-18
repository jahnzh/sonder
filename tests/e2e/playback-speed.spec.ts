import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { listenFace, nowPlaying, openListen } from "./now-playing";
import { playFromLibrary } from "./library-play";
const serverSpeed = async (page: Page) =>
  (await (await page.request.get("/api/appearance")).json()).playback.speed ??
  null;
// The Speed row on Now playing's Listen face (#593).
async function expectDockSpeed(page: Page, speed: string) {
  await openListen(page);
  await expect(
    listenFace(page).getByRole("spinbutton", { name: "Playback speed", exact: true }),
  ).toHaveText(speed);
  await nowPlaying(page).getByRole("button", { name: "Close now playing", exact: true }).click();
  await expect(nowPlaying(page)).toBeHidden();
}
test("the default speed applies once chosen, chapter lengths stay real for a book not in the player, and choosing 1× again keeps it", async ({
  page,
}) => {
  const original = await (await page.request.get("/api/appearance")).json();
  // A PUT without a speed keeps the stored one, so cleanup must send null.
  const withSpeed = (speed: number | null) => ({
    ...original,
    playback: { ...original.playback, speed },
  });
  await page.request.put("/api/appearance", { data: withSpeed(null) });
  const openPlayback = async () => {
    await page.locator(".mobile-nav").getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /^Playback\b/ }).click();
    return page.getByRole("spinbutton", { name: "Default speed", exact: true });
  };
  // A book of two files (two chapters) in the player, so the Chapters page has a chapter that is not the current one,
  // whatever an earlier spec left in the player.
  const title = `Speed chapters ${randomUUID().slice(0, 8)}`;
  const audio = readFileSync("server/demo/alice-01.mp3");
  const imported = await page.request.post("/api/import", {
    multipart: { title, author: "Speed QA", one: { name: "One.mp3", mimeType: "audio/mpeg", buffer: audio }, two: { name: "Two.mp3", mimeType: "audio/mpeg", buffer: audio } } as never,
  });
  expect(imported.ok()).toBe(true);
  const id = (await imported.json()).id as string;
  try {
    await page.goto("/");
    await playFromLibrary(page, title);
    const pause = page.locator(".player-dock").getByRole("button", { name: "Pause", exact: true });
    await expect(pause).toBeVisible();
    await pause.click();
    // Settings › Playback saves the speed when it is changed (#579): ten steps up with Page Up, six more.
    let stepper = await openPlayback();
    await expect(stepper).toHaveText("1×");
    expect(await serverSpeed(page)).toBe(null);
    await stepper.focus();
    await page.keyboard.press("PageUp");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowUp");
    await expect(stepper).toHaveText("1.8×");
    await expect.poll(() => serverSpeed(page)).toBe(1.8);
    await expectDockSpeed(page, "1.8×");
    // Chapter lengths stay real lengths at any speed; only the current chapter's time left is adjusted. The Book page
    // has no chapter list (#532): the Chapters page opened from Listen (#593) lists the recording's chapters.
    await openListen(page);
    await listenFace(page).getByRole("button", { name: /^Chapters\b/ }).click();
    const chapters = page.getByRole("list", { name: "Chapters", exact: true });
    await expect(
      chapters.locator("button:not([aria-current]) .reader-pages-chapter-value").first(),
    ).toHaveAttribute("title", "Chapter length");
    await page.goBack();
    await expect(listenFace(page)).toBeVisible();
    await nowPlaying(page).getByRole("button", { name: "Close now playing", exact: true }).click();
    await expect(nowPlaying(page)).toBeHidden();
    stepper = await openPlayback();
    await stepper.focus();
    await page.keyboard.press("PageDown");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
    await expect(stepper).toHaveText("1×");
    await expect.poll(() => serverSpeed(page)).toBe(1);
    await page.reload();
    await expect(stepper).toHaveText("1×");
    await expectDockSpeed(page, "1×");
  } finally {
    await page.request.delete(`/api/library/${id}`);
    await page.request.put("/api/appearance", {
      data: withSpeed(original.playback.speed ?? null),
    });
  }
});
