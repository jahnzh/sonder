// A slow processor for a spec, opt-in: SONDER_E2E_CPU_THROTTLE=<rate> (or SONDER_CPU_THROTTLE, #702/#707) slows each
// test's page by that factor with Chromium's Emulation.setCPUThrottlingRate (4 is a busy check host). It is how a
// timing fault is shown under load without loading the machine. Other engines have no such call: there it does nothing.
import type { Page, TestType } from "@playwright/test";

export function cpuThrottleRate(env: NodeJS.ProcessEnv = process.env): number {
  const rate = Number(env.SONDER_E2E_CPU_THROTTLE || env.SONDER_CPU_THROTTLE);
  return Number.isFinite(rate) && rate > 1 ? rate : 1;
}

export async function throttleCpu(page: Page, browserName?: string, rate = cpuThrottleRate()) {
  const engine = browserName ?? page.context().browser()?.browserType().name();
  if (rate <= 1 || engine !== "chromium") return false;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installCpuThrottle(test: TestType<any, any>) {
  if (cpuThrottleRate() <= 1) return;
  test.beforeEach(async ({ page, browserName }: { page: Page; browserName: string }) => {
    await throttleCpu(page, browserName);
  });
}
