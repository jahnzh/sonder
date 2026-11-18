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
    await page.getByRole("navigation", { name: "Main", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /^Playback\b/ }).click();
    return page.getByRole("spinbutton", { name: "Default speed", exact: true });
  };
  try {
    await page.goto("/");
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
    // has no chapter list (#532): the player's chapter list, the same component, shows it.
    await page.locator(".dock-book").click();
    const nowPlaying = page.getByRole("dialog", { name: "Now playing", exact: true });
    await expect(nowPlaying).toBeVisible();
    await expect(
      nowPlaying.locator(".chapter-list .chapter-row:not(.selected) small").first(),
    ).toHaveAttribute("title", "Chapter length");
    await nowPlaying.getByRole("button", { name: "Close dialog", exact: true }).click();
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
    await page.request.put("/api/appearance", {
      data: withSpeed(original.playback.speed ?? null),
    });
  }
});
