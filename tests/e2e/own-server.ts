// A server of the test's own (#564): `baseURL` is a fresh `tests/browser-server.ts` on a throwaway database and media
// directory, with the suite's fixtures, so `page.goto` and `page.request` reach it with the paths as written. For specs
// that read the Hardcover fixture's series (The Crossing, #701/#702): on the suite's server the specs before them save
// those series, add their books and open 701's preview, and the fixture lists Crossing Three from the third preview
// on (#206), so what such a spec reads depends on which specs ran before it.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { test as base, expect } from "@playwright/test";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Playwright's `test` with `baseURL` a server started for this test alone and stopped after it. */
export const test = base.extend({
  baseURL: async ({}, use) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
      env: { ...process.env, PLAYWRIGHT_PORT: String(port), SONDER_BROWSER_TEMP: "" },
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => server.once("exit", resolve));
    try {
      await expect.poll(async () => fetch(`${url}/api/health`).then((r) => r.ok, () => false), { timeout: 30000 }).toBe(true);
      await use(url);
    } finally {
      // SIGTERM: the server closes and removes its temporary directory before it exits.
      server.kill();
      await exited;
    }
  },
  // The project that runs the reader's specs on the new reading view (#802) sets its switch for the suite's own
  // address; a test's own server has another, so the switch is set as the app loads there.
  context: async ({ context }, use, info) => {
    if (info.project.name === "prepared-view") await context.addInitScript(() => localStorage.setItem("sonder-reader-view", "prepared"));
    await use(context);
  },
});
export { expect };
