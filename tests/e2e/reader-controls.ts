// Shows the reader's controls with a tap in the middle of the text, for the specs that need its head or its foot's
// transport (#662). A tap there toggles the controls (`pageAction("controls")` in src/components/Reader.tsx), so a
// second tap while the first is still on its way hides them again: on a busy host the render after a tap took longer
// than the 1.5 s the earlier helper waited, it tapped again, the head showed for a moment, the second tap hid it, and
// the next click on a head button waited for a visible button until the test's timeout. Here a tap is repeated only
// when the room still says the controls are off once a tap can no longer be on its way: the room's
// `data-controls-visible` is written in the same render as the head's visibility. A tap can be lost for real while
// the reader replaces the section's frame (it follows a new position): pointerdown in the old frame, pointerup in
// the new one, which is not a tap.
import { expect, type Locator, type Page } from "@playwright/test";

/** How long a tap may take to show the controls before it counts as lost: the render of the reader under load. */
export const TAP_RENDER_MS = 10_000;

export async function revealControls(page: Page, room: Locator, { timeout = 30_000 } = {}) {
  await expect(room.locator(".reader-viewport iframe").first()).toBeVisible();
  await expect(room.locator(".reader-loading")).toHaveCount(0);
  const topbar = room.locator(".reader-topbar");
  await expect(async () => {
    if ((await room.getAttribute("data-controls-visible")) !== "true") {
      const text = (await room.locator(".reader-viewport").boundingBox())!;
      await page.mouse.click(text.x + text.width / 2, text.y + text.height / 2);
      await expect(room).toHaveAttribute("data-controls-visible", "true", { timeout: TAP_RENDER_MS });
    }
    await expect(topbar).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout });
}
