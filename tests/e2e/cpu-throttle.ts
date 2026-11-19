// A slow processor for a spec that failed only under load (#702, #707): SONDER_CPU_THROTTLE=4 slows each page's CPU
// fourfold through CDP's Emulation.setCPUThrottlingRate. Chromium only: Firefox and WebKit have no CDP in Playwright,
// so there it does nothing. Unset, it does nothing anywhere.
import type { Page } from "@playwright/test";

export async function throttleCpu(page: Page): Promise<void> {
  const rate = Number(process.env.SONDER_CPU_THROTTLE || 0);
  if (!(rate > 1) || page.context().browser()?.browserType().name() !== "chromium") return;
  await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });
}
