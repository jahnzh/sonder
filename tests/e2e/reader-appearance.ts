import { expect, type Locator, type Page } from "@playwright/test";
import { intersects, showControls, type Box } from "./reader-bands";
// Appearance docked under the text (#588; ReaderAppearance.dc.html): the helpers the specs that change a reader
// setting share. The panel is opened with the head's Aa and closed with its X; a Stepper is set with its keys.

/** The docked panel of a reader room. */
export const appearancePanel = (room: Locator) => room.getByRole("region", { name: "Reader appearance", exact: true });

/** Shows the controls when they are hidden, docks Appearance with Aa and waits for the panel. */
export async function openAppearance(page: Page, room: Locator) {
  await showControls(page, room);
  await room.locator(".reader-topbar").getByRole("button", { name: "Reader appearance", exact: true }).click();
  const panel = appearancePanel(room);
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes the docked panel with its X; the foot comes back. */
export async function closeAppearance(room: Locator) {
  await appearancePanel(room).getByRole("button", { name: "Close appearance", exact: true }).click();
  await expect(appearancePanel(room)).toHaveCount(0);
}

/** Sets a Stepper of the panel ("Size", "Line height", …) to `value` with its keys, one step at a time. */
export async function setStepper(room: Locator, label: string, value: number) {
  const spin = appearancePanel(room).getByRole("spinbutton", { name: label, exact: true });
  await spin.focus();
  for (let step = 0; step < 100; step++) {
    const now = Number(await spin.getAttribute("aria-valuenow"));
    if (Math.abs(now - value) < 1e-6) return;
    await spin.press(now < value ? "ArrowUp" : "ArrowDown");
    await expect(spin).not.toHaveAttribute("aria-valuenow", String(now));
  }
  throw new Error(`${label} did not reach ${value}`);
}

/** Docks Appearance, sets the text size and closes it again, as the old panel's slider did in one go. */
export async function setTextSize(page: Page, room: Locator, size: number) {
  await openAppearance(page, room);
  await setStepper(room, "Size", size);
  await closeAppearance(room);
}

const boxOf = async (locator: Locator) => {
  const value = await locator.boundingBox();
  if (!value) throw new Error(`No box for ${locator}`);
  return value;
};

/**
 * The rule with Appearance docked (ADR 0019): the head and the panel do not intersect the text, the foot is gone
 * (the panel stands in its place), and the text band is exactly what is left between the head and the panel.
 */
export async function expectDockedUncovered(room: Locator) {
  const head = await boxOf(room.locator(".reader-head"));
  const text = await boxOf(room.locator(".reader-viewport"));
  const panel = await boxOf(appearancePanel(room));
  await expect(room.locator(".reader-player")).toBeHidden();
  for (const [name, value] of Object.entries({ head, panel }))
    expect(intersects(value, text), `${name} ${JSON.stringify(value)} intersects the text ${JSON.stringify(text)}`).toBe(false);
  return { head, text, panel };
}

/** Whether `inner` lies inside `outer` vertically, by more than a rounding error. */
export const insideBand = (inner: { top: number; bottom: number }, outer: Box) =>
  inner.top >= outer.y - 0.5 && inner.bottom <= outer.y + outer.height + 0.5;
