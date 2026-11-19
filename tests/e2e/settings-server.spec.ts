import { test, expect, request as apiRequest, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";

// The Server pages of Settings (#580; spec #572 "Connections", "Users", "Library and storage"; boards
// DesktopSettings.dc.html, SettingsUsers.dc.html, SettingsLibrary.dc.html), against a server of its own with
// sign-in, so there are real accounts and account requests. Measured at 390 by 844 and at a desktop width: one
// Title, rows 52 high (the Used row with its bar 64), no horizontal overflow. Each text field saves with its own
// Save and sends only its own field; a choice saves when it is made.

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
test.afterAll(async () => {
  await admin?.dispose();
  server?.kill();
});
// The server allows ten sign-ins a quarter of an hour from one address: the administrator signs in once, and the
// pages and the API calls share that session.
let admin: Awaited<ReturnType<typeof apiRequest.newContext>> | null = null;
async function adminApi() {
  if (admin) return admin;
  admin = await apiRequest.newContext({ baseURL: base });
  const answer = await admin.post("/api/auth/login", { data: { password: "admin-password" } });
  expect(answer.ok()).toBe(true);
  return admin;
}

const DESKTOP = { width: 1280, height: 900 };
const OUT = "OUT";

async function signIn(page: Page, username: string | null, password: string, address = "/#settings") {
  if (!username) {
    await page.context().addCookies((await (await adminApi()).storageState()).cookies);
    await page.goto(`${base}${address}`);
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
    return;
  }
  await page.goto(`${base}${address}`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
}
async function addAccount(username: string, password: string) {
  const answer = await (await adminApi()).post("/api/users", { data: { username, password } });
  expect(answer.ok(), await answer.text()).toBe(true);
}
async function canSignIn(username: string, password: string) {
  const context = await apiRequest.newContext({ baseURL: base });
  const answer = await context.post("/api/auth/login", { data: { username, password } });
  await context.dispose();
  return answer.ok();
}

const pageTitle = (page: Page, desktop: boolean) => (desktop ? page.locator("#settings-page-title") : page.getByRole("heading", { level: 1 }));

async function expectLaidOut(page: Page) {
  const shown = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const width = document.documentElement.clientWidth;
    const wide = [...main.querySelectorAll("*")]
      .filter((element) => element.getBoundingClientRect().right > width + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)}`);
    const rows = [...main.querySelectorAll(".part-row")].map((row) => [row.hasAttribute("data-moving"), Math.round(row.getBoundingClientRect().height)]);
    return { wide, scrolls: document.documentElement.scrollWidth > width, rows, h1: main.querySelectorAll("h1").length };
  });
  expect(shown.wide, "elements wider than the window").toEqual([]);
  expect(shown.scrolls).toBe(false);
  expect(shown.h1, "one Title").toBe(1);
  for (const [moving, height] of shown.rows) expect(height, moving ? "a row with a bar is 64 high" : "a row is 52 high").toBe(moving ? 64 : 52);
}

for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", DESKTOP]] as const) {
  const desktop = size === "desktop";
  test.describe(`at ${viewport.width} by ${viewport.height}`, () => {
    test.use({ viewport });

    test("Connections: each service and a field saved with its own Save; no Hardcover (#721 part d); the AudiobookDB credit", async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const patches: unknown[] = [];
      const hardcoverCalls: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "PATCH" && request.url().endsWith("/api/settings")) patches.push(request.postDataJSON());
        if (request.url().includes("/api/hardcover")) hardcoverCalls.push(request.url());
      });
      await signIn(page, null, "admin-password", "/#settings/connections");
      await expect(pageTitle(page, desktop)).toHaveText("Connections");
      const main = page.locator("main");
      await expect(main.getByRole("heading", { level: 2 }).filter({ hasNotText: /^Connections$|^Personal$|^Server$|^This device$/ })).toHaveText([
        "TorBox",
        "Prowlarr",
        "AudioBookBay",
        "Library Genesis",
        // The catalogue (#721).
        "AudiobookDB",
        "Open Library",
      ]);
      await expect(main.getByRole("heading", { name: "Anna’s Archive" })).toHaveCount(0);
      // The old long form is gone: no save bar, no section for the local torrent client.
      await expect(main.getByRole("button", { name: /^Save (changes|connections|sync preferences)$/ })).toHaveCount(0);
      await expect(main.getByRole("heading", { name: "Your home server" })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "About TorBox", exact: true })).toBeVisible();
      await expect(main.getByRole("button", { name: "About Prowlarr", exact: true })).toBeVisible();

      // Hardcover is gone: no token, no sync mode, no Sync now; the catalogue's credit links to AudiobookDB.
      await expect(main.getByRole("textbox", { name: "Hardcover API token", exact: true })).toHaveCount(0);
      await expect(main.getByRole("button", { name: /^Sync mode / })).toHaveCount(0);
      await expect(main.getByRole("button", { name: "Sync now", exact: true })).toHaveCount(0);
      const credit = main.getByRole("link", { name: "Data from AudiobookDB", exact: true });
      await expect(credit).toBeVisible();
      await expect(credit).toHaveAttribute("href", "https://audiobookdb.org");

      // An address with its own Save sends only that field, and stays as saved.
      const libgen = main.getByRole("textbox", { name: "Library Genesis address", exact: true });
      await expect(libgen).toHaveValue("https://libgen.li");
      await libgen.fill("https://libgen.is");
      await main.getByRole("button", { name: "Save Library Genesis address", exact: true }).click();
      await expect.poll(() => patches.at(-1)).toEqual({ libgenUrl: "https://libgen.is" });
      await expect(main.getByRole("button", { name: "Save Library Genesis address", exact: true })).toBeDisabled();
      await page.reload();
      await expect(main.getByRole("textbox", { name: "Library Genesis address", exact: true })).toHaveValue("https://libgen.is");
      await expect(main.getByRole("textbox", { name: "AudioBookBay address", exact: true })).toHaveValue("https://audiobookbay.lu");
      await expect(main.getByRole("textbox", { name: "Prowlarr address", exact: true })).toBeVisible();
      await expect(main.getByRole("textbox", { name: "TorBox API key", exact: true })).toBeVisible();
      await expectLaidOut(page);
      mkdirSync(OUT, { recursive: true });
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/settings-connections-${size}.png`, fullPage: true });
      // Put the server back as it was for the other viewport's run.
      const api = await adminApi();
      await api.patch("/api/settings", { data: { libgenUrl: "https://libgen.li" } });
      expect(hardcoverCalls).toEqual([]);
      expect(errors).toEqual([]);
    });

    test("Users: a request approved with the invite line, one declined, a user added, a password reset and a user removed", async ({ page }, info) => {
      const suffix = `${size.slice(0, 1)}${info.project.name.slice(0, 2)}`;
      const names = { approved: `amy${suffix}`, declined: `dan${suffix}`, added: `cal${suffix}` };
      const visitor = await apiRequest.newContext({ baseURL: base });
      // Each request from a visitor of its own (behind the server's loopback proxy): one address may ask three times
      // an hour.
      for (const [index, username] of [names.approved, names.declined].entries()) {
        const sent = await visitor.post("/api/account-requests", { headers: { "x-forwarded-for": `192.0.2.${desktop ? 20 + index : 10 + index}` }, data: { email: `${username}@example.com`, username, note: `Note from ${username}`, honeypot: "" } });
        expect(sent.ok(), await sent.text()).toBe(true);
      }
      await visitor.dispose();
      await signIn(page, null, "admin-password", "/#settings/users");
      await expect(pageTitle(page, desktop)).toHaveText("Users");
      const main = page.locator("main");
      await expect(main.getByRole("heading", { name: /^Accounts · \d+$/ })).toBeVisible();
      // The administrator's row opens nothing and says the role.
      await expect(main.getByRole("listitem").filter({ hasText: /^admin\s*Administrator$/ })).toBeVisible();
      await expect(main.getByRole("button", { name: /^admin\b/ })).toHaveCount(0);
      const requests = main.getByRole("list", { name: /^Account requests · \d+$/ });
      const approved = requests.getByRole("listitem", { name: names.approved, exact: true });
      await expect(approved).toContainText(`${names.approved}@example.com`);
      await expect(approved).toContainText(`Note from ${names.approved}`);
      await expect(approved).toContainText(/just now|minutes? ago/);
      await expect(main.getByText("Approving sends an invite link by email. The link works for 7 days.", { exact: true })).toBeVisible();
      await approved.getByRole("button", { name: "Approve", exact: true }).click();
      // No mail is set up on the suite's server: the email was not sent, and the link is there to copy.
      const line = main.getByRole("status").filter({ hasText: `Approved ${names.approved}.` });
      await expect(line).toContainText(`Approved ${names.approved}. The invite email was not sent.`);
      await expect(line.locator("code")).toHaveText(/\/join\?token=[0-9a-f]{64}$/);
      await expect(line.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
      await expect(approved).toHaveCount(0);
      const declined = requests.getByRole("listitem", { name: names.declined, exact: true });
      await declined.getByRole("button", { name: "Decline", exact: true }).click();
      await expect(declined).toHaveCount(0);
      await expect(main.getByText("No account requests", { exact: true })).toBeVisible();
      expect((await (await (await adminApi()).get("/api/account-requests")).json()).map((r: { username: string }) => r.username)).not.toContain(names.declined);

      // Add user in a dialog: Username and Password, no role field; the new account is a User.
      await main.getByRole("button", { name: "Add user", exact: true }).click();
      const add = page.getByRole("dialog", { name: "Add user", exact: true });
      await expect(add.getByLabel("Role")).toHaveCount(0);
      await add.getByLabel("Username").fill(names.added);
      await add.getByLabel("Password", { exact: true }).fill("first-password");
      await add.getByRole("button", { name: "Add user", exact: true }).click();
      await expect(add).toHaveCount(0);
      const row = main.getByRole("button", { name: `${names.added} User`, exact: true });
      await expect(row).toBeVisible();
      await expectLaidOut(page);
      mkdirSync(OUT, { recursive: true });
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/settings-users-${size}.png`, fullPage: true });

      // A row opens its dialog: Reset password asks for the new one once.
      await row.click();
      let dialog = page.getByRole("dialog", { name: names.added, exact: true });
      await dialog.getByRole("button", { name: "Reset password", exact: true }).click();
      dialog = page.getByRole("dialog", { name: `Reset password for ${names.added}`, exact: true });
      await dialog.getByLabel("New password").fill("second-password");
      await dialog.getByRole("button", { name: "Reset password", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".toast")).toContainText("Password reset.");
      expect(await canSignIn(names.added, "second-password")).toBe(true);
      expect(await canSignIn(names.added, "first-password")).toBe(false);

      // Remove user asks once, then the row goes.
      await row.click();
      await page.getByRole("dialog", { name: names.added, exact: true }).getByRole("button", { name: "Remove user", exact: true }).click();
      dialog = page.getByRole("dialog", { name: `Remove ${names.added}?`, exact: true });
      await dialog.getByRole("button", { name: "Remove user", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row).toHaveCount(0);
      expect((await (await (await adminApi()).get("/api/users")).json()).map((account: { username: string }) => account.username)).not.toContain(names.added);
    });

    test("Library and storage: the name saved with its Save, the drive connected with Used, then not connected (a routed answer)", async ({ page }, info) => {
      const patches: unknown[] = [];
      page.on("request", (request) => {
        if (request.method() === "PATCH" && request.url().endsWith("/api/settings")) patches.push(request.postDataJSON());
      });
      await signIn(page, null, "admin-password", "/#settings/library");
      await expect(pageTitle(page, desktop)).toHaveText("Library and storage");
      const main = page.locator("main");
      const name = main.getByRole("textbox", { name: "Library name", exact: true });
      const was = await name.inputValue();
      await name.fill("Shelf of tests");
      await main.getByRole("button", { name: "Save Library name", exact: true }).click();
      await expect.poll(() => patches.at(-1)).toEqual({ name: "Shelf of tests" });
      // The suite's server records no volume, so its media drive is connected; its sizes come from statfs.
      await expect(main.getByRole("listitem", { name: /^Media drive Connected$/ })).toBeVisible();
      await expect(main.getByRole("button", { name: "About Media drive", exact: true })).toBeVisible();
      const used = main.getByRole("listitem", { name: /^Used / });
      await expect(used).toHaveAccessibleName(/^Used [\d.]+ (KB|MB|GB|TB)?\s?of [\d.]+ (KB|MB|GB|TB) · [\d.]+ (KB|MB|GB|TB) free$/);
      await expect(used.locator(".part-progress")).toBeVisible();
      await expectLaidOut(page);
      mkdirSync(OUT, { recursive: true });
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/settings-library-${size}.png`, fullPage: true });
      await (await adminApi()).patch("/api/settings", { data: { name: was } });

      // The drive not connected: the answer the server gives without its volume marker, routed.
      await page.route("**/api/settings", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const real = await (await route.fetch()).json();
        await route.fulfill({ json: { ...real, storage: { connected: false, usedBytes: null, totalBytes: null } } });
      });
      await page.reload();
      const drive = main.getByRole("listitem", { name: /^Media drive Not connected$/ });
      await expect(drive).toBeVisible();
      const colours = await drive.evaluate((item) => ({
        value: getComputedStyle(item.querySelector(".part-row-value")!).color,
        danger: getComputedStyle(document.documentElement).getPropertyValue("--danger").trim(),
      }));
      const probe = await page.evaluate((colour) => {
        const element = document.createElement("span");
        element.style.color = colour;
        document.body.append(element);
        const computed = getComputedStyle(element).color;
        element.remove();
        return computed;
      }, colours.danger);
      expect(colours.value, "Not connected in the failed colour").toBe(probe);
      await expect(main.getByRole("listitem", { name: /^Used / })).toHaveCount(0);
      // The list's row says it too.
      if (desktop) await expect(page.getByRole("navigation", { name: "Settings", exact: true }).getByRole("button", { name: /^Library and storage\s*Not connected/ })).toBeVisible();
      await expectLaidOut(page);
      if (info.project.name === "chromium") await page.screenshot({ path: `${OUT}/settings-library-not-connected-${size}.png`, fullPage: true });
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });

    test("someone who is not the administrator reaches none of the Server pages by address, Connections included since Hardcover went", async ({ page }, info) => {
      const username = `reader${size.slice(0, 1)}${info.project.name.slice(0, 2)}`;
      await addAccount(username, "reader-password");
      await signIn(page, username, "reader-password", "/#settings");
      const list = page.getByRole("navigation", { name: "Settings", exact: true });
      await expect(list.getByRole("button", { name: /^Account\b/ })).toBeVisible();
      await expect(list.getByRole("heading", { name: "Server" })).toHaveCount(0);
      await expect(list.getByRole("button", { name: /^Connections\b/ })).toHaveCount(0);
      for (const word of ["users", "library", "connections"]) {
        await page.goto(`${base}/#settings/${word}`);
        await expect.poll(() => page.evaluate(() => location.hash)).toBe("#settings");
        await expect(list).toBeVisible();
        await expect(page.getByRole("heading", { name: { users: "Users", library: "Library and storage", connections: "Connections" }[word] })).toHaveCount(0);
        await expect(page.getByRole("textbox", { name: "Library name" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Add user" })).toHaveCount(0);
      }
      const main = page.locator("main");
      for (const service of ["TorBox", "Hardcover", "Prowlarr", "AudioBookBay", "Library Genesis", "AudiobookDB", "Open Library"])
        await expect(main.getByRole("heading", { name: service, exact: true })).toHaveCount(0);
      await expect(main.getByRole("textbox", { name: "TorBox API key" })).toHaveCount(0);
      // Their settings carry no storage and none of the server's connections.
      const settings = await (await page.request.get(`${base}/api/settings`)).json();
      expect(Object.keys(settings).sort()).toEqual(["authenticationEnabled", "hardcoverConfigured", "name", "role"]);
      await expectLaidOut(page);
    });
  });
}
