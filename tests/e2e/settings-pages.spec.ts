import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";

// Settings as a list with pages (#579; spec #572 "Settings"; boards Settings.dc.html, SettingsAccount.dc.html,
// SettingsAppearance.dc.html, SettingsPlayback.dc.html, SettingsApp.dc.html, DesktopSettings.dc.html). Measured at
// 390 by 844 and at a desktop width: every page by its address and from the list, one Title, 52 high rows, no
// horizontal overflow; a stepper and a switch saved at once and kept after a reload; App with an update ready;
// Account and the list for the administrator and for someone else, and Sign out.

const DESKTOP = { width: 1280, height: 900 };
const ADMIN_PAGES = [
  ["account", "Account"],
  ["appearance", "Appearance"],
  ["playback", "Playback"],
  ["connections", "Connections"],
  ["users", "Users"],
  ["library", "Library and storage"],
  ["app", "App"],
] as const;

const hash = (page: Page) => page.evaluate(() => location.hash);
const settingsList = (page: Page) => page.getByRole("navigation", { name: "Settings", exact: true });
const listRow = (page: Page, label: string) => settingsList(page).getByRole("button", { name: new RegExp(`^${label}\\b`) });
/** The page's Title: the one h1 on a phone, the heading beside the list on a desktop. */
const title = (page: Page, desktop: boolean) =>
  desktop ? page.locator("#settings-page-title") : page.getByRole("heading", { level: 1 });

async function measure(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main")!;
    const width = document.documentElement.clientWidth;
    const wide = [...main.querySelectorAll("*")]
      .filter((element) => element.getBoundingClientRect().right > width + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
    const rows = [...main.querySelectorAll(".part-row")].map((row) => Math.round(row.getBoundingClientRect().height));
    return { wide, scrolls: document.documentElement.scrollWidth > width, rows, h1: main.querySelectorAll("h1").length };
  });
}
async function expectLaidOut(page: Page) {
  const shown = await measure(page);
  expect(shown.wide, "elements wider than the window").toEqual([]);
  expect(shown.scrolls).toBe(false);
  expect(shown.h1, "one Title").toBe(1);
  expect(new Set(shown.rows), "every row 52 high").toEqual(new Set([52]));
}

for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", DESKTOP]] as const) {
  const desktop = size === "desktop";
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ viewport });

    test("the list: groups, rows and their values, in the boards' order", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto("/#settings");
      const list = settingsList(page);
      await expect(list.getByRole("heading")).toHaveText(["Personal", "Server", "This device"]);
      await expect(list.getByRole("button")).toHaveText([
        /^Account\s*admin · Admin/,
        /^Appearance\s*\S/,
        /^Playback\s*[\d.]+×/,
        /^Connections\s*\S/,
        /^Users\s*\d+ accounts?/,
        /^Library and storage/,
        /^App\s*(Installed|Install)/,
      ]);
      await expectLaidOut(page);
      // On a desktop the list has Account beside it, at `#settings`.
      if (desktop) await expect(title(page, true)).toHaveText("Account");
      else await expect(title(page, false)).toHaveText("Settings");
      expect(await hash(page)).toBe("#settings");
      expect(errors).toEqual([]);
    });

    test("each page by its address and from the list", async ({ page }) => {
      for (const [word, name] of ADMIN_PAGES) {
        await page.goto(`/#settings/${word}`);
        await expect(title(page, desktop)).toHaveText(name);
        if (desktop) await expect(settingsList(page)).toBeVisible();
        else {
          await expect(page.getByRole("button", { name: "Back to Settings", exact: true })).toBeVisible();
          await expect(settingsList(page)).toHaveCount(0);
        }
        await expectLaidOut(page).catch(async (error) => {
          // The Server pages show today's sections of the long form until their slice; only the list's rows are rows.
          if (!["connections", "users", "library"].includes(word)) throw error;
          const shown = await measure(page);
          expect(shown.wide).toEqual([]);
          expect(shown.scrolls).toBe(false);
          expect(shown.h1).toBe(1);
        });
      }
      await page.goto("/#settings");
      const length = await page.evaluate(() => history.length);
      for (const [word, name] of ADMIN_PAGES) {
        await listRowOrBack(page, desktop);
        await listRow(page, name).click();
        // On a desktop Account is already beside the list at `#settings`.
        await expect.poll(() => hash(page)).toBe(desktop && word === "account" ? "#settings" : `#settings/${word}`);
        await expect(title(page, desktop)).toHaveText(name);
      }
      if (desktop) {
        // Choosing another row beside the list replaces the history entry.
        expect(await page.evaluate(() => history.length)).toBe(length);
      } else {
        await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
        await expect.poll(() => hash(page)).toBe("#settings");
        await expect(title(page, false)).toHaveText("Settings");
      }
    });

    test("a word that names no page shows Settings", async ({ page }) => {
      await page.goto("/#settings/reading");
      await expect.poll(() => hash(page)).toBe("#settings");
      await expect(settingsList(page)).toBeVisible();
    });

    test("a stepper and a switch are saved at once and kept after a reload", async ({ page }) => {
      const saves: { scale: number }[] = [];
      page.on("request", (request) => {
        if (request.method() === "PUT" && request.url().endsWith("/api/appearance")) saves.push(request.postDataJSON());
      });
      await page.goto("/#settings/appearance");
      const size = page.getByRole("spinbutton", { name: "Text size", exact: true });
      await expect(size).toHaveText("100%");
      await page.getByRole("button", { name: "Larger text", exact: true }).click();
      await expect(size).toHaveText("105%");
      // Saved when changed: no Save button, the server has it.
      await expect.poll(() => saves.at(-1)?.scale).toBe(1.05);
      await expect(page.locator("main").getByRole("button", { name: /^Save/ })).toHaveCount(0);
      await page.reload();
      await expect(size).toHaveText("105%");
      expect((await (await page.request.get("/api/appearance")).json()).scale).toBe(1.05);
      await page.getByRole("button", { name: "Smaller text", exact: true }).click();
      await expect(size).toHaveText("100%");
      await expect.poll(async () => (await (await page.request.get("/api/appearance")).json()).scale).toBe(1);

      await page.goto("/#settings/playback");
      const follow = page.getByRole("switch", { name: "Follow the narration", exact: true });
      await expect(follow).toHaveAttribute("aria-checked", "true");
      await follow.click();
      await expect(follow).toHaveAttribute("aria-checked", "false");
      await page.reload();
      await expect(follow).toHaveAttribute("aria-checked", "false");
      await follow.click();
      await expect(follow).toHaveAttribute("aria-checked", "true");
    });

    test("App: up to date, then an update ready with Reload", async ({ browser }) => {
      // Firefox does not route a request the service worker makes once it controls the page: this page has none.
      const context = await browser.newContext({ viewport, serviceWorkers: "block", baseURL: test.info().project.use.baseURL });
      const page = await context.newPage();
      let newer = false;
      await context.route("**/build.json", (route) => (newer ? route.fulfill({ json: { id: "a-newer-build" } }) : route.continue()));
      await page.goto("/#settings/app");
      const app = page.getByRole("list", { name: "This app", exact: true });
      const updates = app.getByRole("listitem").filter({ hasText: "Updates" });
      await expect(updates).toContainText("Up to date");
      await expect(app.getByRole("listitem").filter({ hasText: "Version" })).not.toHaveText(/^Version\s*$/);
      // A build published after this tab opened: the next check (here, the window gaining focus) finds it.
      newer = true;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(updates).toContainText("An update is ready");
      // One Reload on screen: the shell's update notice stays away while this page shows its own (#733).
      await expect(page.locator(".app-update")).toHaveCount(0);
      await expectLaidOut(page);
      await Promise.all([page.waitForEvent("load"), updates.getByRole("button", { name: "Reload", exact: true }).click()]);
      await expect(title(page, desktop)).toHaveText("App");
      await context.close();
    });
  });
}

/** On a phone a page covers the list: go back to it first. */
async function listRowOrBack(page: Page, desktop: boolean) {
  if (desktop) return;
  const back = page.getByRole("button", { name: "Back to Settings", exact: true });
  if (await back.isVisible()) {
    await back.click();
    await expect.poll(() => hash(page)).toBe("#settings");
  }
}

// Signing in is required here, so Account shows Sign out, and a second account can be made.
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
test.describe("with signing in", () => {
  let server: ChildProcess;
  let base = "";
  test.beforeAll(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
        env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port) },
        stdio: "ignore",
      });
      for (let i = 0; i < 100 && server.exitCode === null; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      server.kill();
    }
    throw new Error("Authenticated browser server did not start");
  });
  test.afterAll(() => {
    server?.kill();
  });
  const signIn = async (page: Page, username: string, password: string) => {
    await page.goto(base);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Settings", exact: true }).last()).toBeVisible();
  };

  for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", DESKTOP]] as const) {
    test(`Account for the administrator and for someone else, the list for someone else, and Sign out (${size})`, async ({ page }) => {
      test.use;
      await page.setViewportSize(viewport);
      const desktop = size === "desktop";
      const reader = `reader-${size}`;
      await signIn(page, "admin", "admin-password");
      const made = await page.request.post(`${base}/api/users`, { data: { username: reader, password: "reader-password" } });
      expect(made.ok()).toBe(true);
      await page.goto(`${base}/#settings/account`);
      await expect(title(page, desktop)).toHaveText("Account");
      const account = page.getByRole("list", { name: "Account", exact: true });
      await expect(account.getByRole("listitem")).toHaveText([/Username\s*admin/, /Role\s*Administrator/]);
      await expect(page.getByText("The administrator’s password is set on the server.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Change password" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
      await expectLaidOut(page);
      // Sign out returns to Sign in.
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Sign out", exact: true }).click()]);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

      await signIn(page, reader, "reader-password");
      await page.goto(`${base}/#settings`);
      const list = settingsList(page);
      await expect(list.getByRole("heading")).toHaveText(["Personal", "This device"]);
      await expect(list.getByRole("button")).toHaveText([
        new RegExp(`^Account\\s*${reader} · User`),
        /^Appearance/,
        /^Playback/,
        /^Connections\s*Not connected/,
        /^App/,
      ]);
      await expectLaidOut(page);
      // The administrator's pages show Settings to someone else.
      for (const word of ["users", "library"]) {
        await page.goto(`${base}/#settings/${word}`);
        await expect.poll(() => hash(page)).toBe("#settings");
      }
      // Connections has Hardcover only.
      await page.goto(`${base}/#settings/connections`);
      await expect(page.getByRole("heading", { name: "Hardcover", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "TorBox", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Prowlarr", exact: true })).toHaveCount(0);

      await page.goto(`${base}/#settings/account`);
      await expect(page.getByRole("list", { name: "Account", exact: true }).getByRole("listitem")).toHaveText([
        new RegExp(`Username\\s*${reader}`),
        /Role\s*User/,
      ]);
      await expect(page.getByText("The administrator’s password is set on the server.")).toHaveCount(0);
      const password = page.getByRole("list", { name: "Password", exact: true });
      await password.getByLabel("Current password").fill("reader-password");
      await password.getByLabel("New password").fill("reader-password-2");
      const changed = page.waitForResponse((response) => response.url().endsWith("/api/auth/password") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Change password", exact: true }).click();
      expect((await changed).ok()).toBe(true);
      await expect(page.getByText("Password changed.", { exact: true })).toBeVisible();
      await expect(password.getByLabel("New password")).toHaveValue("");
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Sign out", exact: true }).click()]);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      // The new password signs in.
      await signIn(page, reader, "reader-password-2");
    });
  }
});
