// @projects firefox, mobile-iphone-slice13
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import { tempDir } from "../temp-dir";

// Sign in, Request an account and Join in the new parts (#582; spec #572, "Sign in, Request an account, Join";
// boards SignIn.dc.html, SignInRequest.dc.html, Join.dc.html, JoinExpired.dc.html). Each page is measured against
// its board at 390 by 844 and at desktop width; the guards of the spec's list 9, 10, 12 and 13 are here in their new
// form. The spec runs its own server with a password, as the shared one runs without.

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

let server: ChildProcess | undefined;
let base = "";
let dataDir = "";
// The port can be taken between freePort() closing its probe and the server binding it, so retry on a new port.
test.beforeAll(async () => {
  dataDir = join(tempDir("sonder-sign-in-e2e-"), "db");
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // APP_URL points the invite link at this spec's server, so the link the approval answers is the one opened.
    server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], {
      env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", APP_URL: base, PLAYWRIGHT_PORT: String(port), PLAYWRIGHT_DATA_DIR: dataDir },
      stdio: "ignore",
    });
    for (let i = 0; i < 150 && server.exitCode === null; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    server.kill();
  }
  throw new Error("Authenticated browser server did not start");
});
test.afterAll(() => {
  server?.kill();
});

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const KEYBOARD = 300;

async function fresh(browser: Browser, viewport = PHONE): Promise<Page> {
  const context = await browser.newContext({ viewport });
  return context.newPage();
}
async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, String(locator)).not.toBeNull();
  return b!;
}
/** What every page before an account shares: Sonder's name, one Title, nothing of the shell, no sideways scroll. */
async function expectPageFrame(page: Page, title: string, viewport: { width: number; height: number }) {
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveCount(1);
  await expect(h1).toHaveText(title);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.locator(".player-dock")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Settings/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".signin-page")!).backgroundColor)).toBe("rgb(16, 21, 16)");
  const brand = page.locator(".signin-brand");
  await expect(brand).toHaveText("Sonder");
  const column = await box(page.locator(".signin-column"));
  const brandBox = await box(brand);
  expect(brandBox.height).toBe(44);
  if (viewport.width < 760) {
    // The screen edge is 16 on a phone.
    expect(column.x).toBe(16);
    expect(column.width).toBe(viewport.width - 32);
  } else {
    // On a desktop the same column, at most 400 wide and centred.
    expect(column.width).toBe(400);
    expect(Math.abs(column.x + column.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  }
  // The Title is 24 under Sonder's name or the block before it, and one line: its height is the line height (34 in
  // the app's own fonts). The fonts are bundled but load on first use, so wait for them: measured on the fallback
  // font the Title can be wider and wrap (#643). A wrapped Title is twice the line height and still fails.
  await page.evaluate(() => document.fonts.ready);
  const lineHeight = await h1.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect(lineHeight).toBeGreaterThan(0);
  expect((await box(h1)).height).toBe(lineHeight);
  return column;
}
/** Each block's top is 24 under the previous one's bottom (the boards' gap), in the order given. */
async function expectStacked(blocks: Locator[], gap = 24) {
  let previous = await box(blocks[0]);
  for (const block of blocks.slice(1)) {
    const next = await box(block);
    expect(Math.round(next.y - (previous.y + previous.height)), String(block)).toBe(gap);
    previous = next;
  }
}
/** The colour a CSS variable of the page resolves to, as getComputedStyle writes colours. */
async function resolved(page: Page, variable: string) {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, variable);
}
/** Narrows the visual viewport as a phone's keyboard does, leaving the layout viewport as it is. */
async function raiseKeyboard(page: Page, inset: number) {
  await page.evaluate((inset) => {
    const view = window.visualViewport!;
    const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(view), "height")!.get!;
    Object.defineProperty(view, "height", { configurable: true, get: () => real.call(view) - inset });
    view.dispatchEvent(new Event("resize"));
  }, inset);
}
async function signIn(page: Page) {
  await page.getByLabel("Password", { exact: true }).fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
}

for (const [name, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`Sign in as its board on a ${name}`, async ({ browser }) => {
    const page = await fresh(browser, viewport);
    await page.goto(base);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const column = await expectPageFrame(page, "Sign in", viewport);
    // Today's narration art, out of the accessibility tree, in a card the column's width.
    const art = page.locator(".signin-art");
    await expect(art).toHaveAttribute("aria-hidden", "true");
    expect((await box(art)).width).toBe(column.width);
    const username = page.getByLabel("Username");
    const password = page.getByLabel("Password", { exact: true });
    const show = page.getByRole("button", { name: "Show password" });
    const main = page.getByRole("button", { name: "Sign in" });
    const request = page.getByRole("button", { name: "Request an account" });
    for (const control of [username, password, show, main, request]) expect((await box(control)).height).toBe(44);
    expect((await box(show)).width).toBe(44);
    // One main button, the column's width.
    expect((await box(main)).width).toBe(column.width);
    await expect(page.locator(".part-button[data-kind='primary']")).toHaveCount(1);
    // Password and Show password side by side, 8 apart, filling the column.
    const [passwordBox, showBox] = [await box(password), await box(show)];
    expect(showBox.x - (passwordBox.x + passwordBox.width)).toBe(8);
    expect(showBox.x + showBox.width).toBe(column.x + column.width);
    await expectStacked([page.locator(".signin-brand"), art, page.getByRole("heading", { name: "Sign in" }), page.locator(".signin-form"), request]);
    // Request an account is centred under the form.
    const requestBox = await box(request);
    expect(Math.abs(requestBox.x + requestBox.width / 2 - (column.x + column.width / 2))).toBeLessThanOrEqual(1);
    mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: `artifacts/sign-in-${name}.png` });
    await page.context().close();
  });
}

// List 9 of the spec: the password toggle, the busy state and "Incorrect username or password".
test("the sign-in page shows the password toggle, the busy label and the error in the failed colour", async ({ browser }) => {
  const page = await fresh(browser);
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const password = page.getByLabel("Password", { exact: true });
  await expect(page.getByLabel("Username")).toBeFocused();
  await password.fill("wrong-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/auth/login", async (route) => { await held; await route.continue(); });
  await page.getByRole("button", { name: "Sign in" }).click();
  const busy = page.getByRole("button", { name: "Signing in" });
  await expect(busy).toHaveAttribute("aria-busy", "true");
  release();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("Incorrect username or password");
  await expect(password).toHaveAttribute("aria-invalid", "true");
  expect(await alert.locator("p").evaluate((element) => getComputedStyle(element).color)).toBe(await resolved(page, "--danger"));
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/sign-in-phone-error.png" });
  await password.fill("admin-password");
  await expect(alert).toHaveText("");
  await page.unroute("**/api/auth/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  await page.context().close();
});

for (const [name, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`Request an account as its board on a ${name}`, async ({ browser }) => {
    const page = await fresh(browser, viewport);
    await page.goto(base);
    await page.getByRole("button", { name: "Request an account" }).click();
    const sheet = page.getByRole("dialog", { name: "Request an account" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { level: 1 })).toHaveText("Request an account");
    await expect(sheet.getByText("The administrator reviews each request and sends an invite link by email.")).toBeVisible();
    await expect(sheet.getByText("Letters, numbers, dots, dashes or underscores.")).toBeVisible();
    // The sheet covers the screen; Close at its top left, 16 from the edges on a phone.
    const sheetBox = await box(sheet);
    expect(sheetBox).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    const close = sheet.getByRole("button", { name: "Close" });
    const closeBox = await box(close);
    expect(closeBox.width).toBe(44);
    expect(closeBox.height).toBe(44);
    for (const field of [sheet.getByLabel("Email"), sheet.getByLabel("Username")]) expect((await box(field)).height).toBe(44);
    expect((await box(sheet.getByLabel("Note optional"))).height).toBe(88);
    const send = sheet.getByRole("button", { name: "Send request" });
    const sendBox = await box(send);
    expect(sendBox.height).toBe(44);
    // Send request is the foot, the column's width, at the bottom edge.
    const column = await box(sheet.locator(".part-sheet-column"));
    expect(sendBox.width).toBe(column.width);
    expect(Math.round(sendBox.y + sendBox.height)).toBe(Math.round(column.y + column.height));
    if (viewport.width < 760) expect(closeBox).toMatchObject({ x: 16, y: 16 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: `artifacts/sign-in-request-${name}.png` });
    await close.click();
    await expect(sheet).toBeHidden();
    // Focus goes back to what opened it.
    await expect(page.getByRole("button", { name: "Request an account" })).toBeFocused();
    await page.context().close();
  });
}

// List 10 of the spec, now a sheet.
test("a visitor asks for an account from the sign-in page in a sheet", async ({ browser }) => {
  const page = await fresh(browser);
  await page.goto(base);
  await page.getByRole("button", { name: "Request an account" }).click();
  const sheet = page.getByRole("dialog", { name: "Request an account" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel("Email")).toBeFocused();
  // The hidden field for bots is rendered but out of sight and out of the tab order.
  const website = sheet.getByLabel("Website");
  await expect(website).toHaveAttribute("tabindex", "-1");
  const hidden = await box(sheet.locator(".signin-honeypot"));
  expect(hidden.width * hidden.height).toBeLessThanOrEqual(1);
  await expect(sheet.locator(".signin-honeypot")).toHaveAttribute("aria-hidden", "true");
  await sheet.getByLabel("Note optional").focus();
  await page.keyboard.press("Tab");
  await expect(website).not.toBeFocused();
  await expect(sheet.getByRole("button", { name: "Send request" })).toBeFocused();
  // Invalid formats are refused before anything is sent.
  let sent = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/account-requests")) sent++; });
  await sheet.getByLabel("Email").fill("not-an-email");
  await sheet.getByLabel("Username").fill("a");
  await sheet.getByRole("button", { name: "Send request" }).click();
  await expect(sheet.getByText("Enter a valid email address.")).toBeVisible();
  await expect(sheet.getByText("Usernames are 2 to 40 characters.")).toBeVisible();
  await expect(sheet.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  expect(sent).toBe(0);
  await sheet.getByLabel("Email").fill("bradley@example.com");
  await sheet.getByLabel("Username").fill("bradley");
  await sheet.getByLabel("Note optional").fill("Just want access for a while");
  await sheet.getByRole("button", { name: "Send request" }).click();
  await expect(sheet.getByRole("status")).toHaveText("Your request has been received.");
  expect(sent).toBe(1);
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/sign-in-request-received.png" });
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  // The request reached the administrator's queue with its note.
  await page.request.post(`${base}/api/auth/login`, { data: { password: "admin-password" } });
  const rows = (await (await page.request.get(`${base}/api/account-requests`)).json()) as { username: string; note: string | null }[];
  expect(rows.find((row) => row.username === "bradley")?.note).toBe("Just want access for a while");
  await page.context().close();
});

test("Request an account keeps its last field and Send request above a 300 px keyboard", async ({ browser }) => {
  const page = await fresh(browser);
  await page.goto(base);
  await page.getByRole("button", { name: "Request an account" }).click();
  const sheet = page.getByRole("dialog", { name: "Request an account" });
  const note = sheet.getByLabel("Note optional");
  await note.focus();
  await raiseKeyboard(page, KEYBOARD);
  const room = PHONE.height - KEYBOARD;
  await expect.poll(async () => Math.round((await box(sheet)).height)).toBe(room);
  for (const control of [note, sheet.getByRole("button", { name: "Send request" })]) {
    await expect.poll(async () => {
      const b = await box(control);
      return b.y >= 0 && b.y + b.height <= room;
    }, String(control)).toBe(true);
  }
  await expect(note).toBeFocused();
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/sign-in-request-keyboard.png" });
  await page.context().close();
});

test("Request an account keeps its last field visible when the keyboard shrinks the whole window", async ({ browser }) => {
  const page = await fresh(browser);
  await page.goto(base);
  await page.getByRole("button", { name: "Request an account" }).click();
  const sheet = page.getByRole("dialog", { name: "Request an account" });
  const note = sheet.getByLabel("Note optional");
  await note.focus();
  await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD });
  const room = PHONE.height - KEYBOARD;
  for (const control of [note, sheet.getByRole("button", { name: "Send request" })]) {
    await expect.poll(async () => {
      const b = await box(control);
      return b.y >= 0 && b.y + b.height <= room;
    }, String(control)).toBe(true);
  }
  await page.context().close();
});

test("signing in from a deep link lands on it, and the request sheet leaves the address alone", async ({ browser }) => {
  const page = await fresh(browser);
  // Activity is the administrator's page: the address must survive until the sign-in says who this is.
  await page.goto(`${base}/#activity`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const length = await page.evaluate(() => history.length);
  // The sheet has no address: opening and closing it changes neither the address nor the history.
  await page.getByRole("button", { name: "Request an account" }).click();
  await expect(page.getByRole("dialog", { name: "Request an account" })).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("#activity");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Request an account" })).toBeHidden();
  expect(await page.evaluate(() => [location.hash, history.length])).toEqual(["#activity", length]);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("#activity");
  await page.context().close();
});

test("signing in without an address asked for lands on the Library", async ({ browser }) => {
  const page = await fresh(browser);
  await page.goto(base);
  await signIn(page);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#library");
  await page.context().close();
});

/** A pending request written straight into the spec's database, approved as the administrator: the invite link. */
async function approvedInvite(page: Page, username: string): Promise<string> {
  const db = new Database(join(dataDir, "sonder.db"));
  let id: number;
  try {
    id = Number(db.prepare("INSERT INTO account_requests(email,username,note,created_at,status) VALUES(?,?,?,?,?)").run(`${username}@example.com`, username, null, Date.now(), "pending").lastInsertRowid);
  } finally {
    db.close();
  }
  const admin = page.context().request;
  expect((await admin.post(`${base}/api/auth/login`, { data: { password: "admin-password" } })).ok()).toBe(true);
  const approval = await admin.post(`${base}/api/account-requests/${id}/approve`, { data: {} });
  expect(approval.ok()).toBe(true);
  const { inviteLink } = (await approval.json()) as { inviteLink: string };
  expect(inviteLink).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/join\?token=[0-9a-f]{64}$/);
  await admin.post(`${base}/api/auth/logout`, { data: {} });
  return inviteLink;
}
/** An invite that expired a day ago, written straight into the spec's database. */
function expiredInvite(): string {
  const token = randomBytes(32).toString("hex");
  const db = new Database(join(dataDir, "sonder.db"));
  try {
    const now = Date.now();
    const username = `expired${randomBytes(2).toString("hex")}`;
    const requestId = Number(db.prepare("INSERT INTO account_requests(email,username,note,created_at,status,reviewed_at) VALUES(?,?,?,?,?,?)").run(`${username}@example.com`, username, null, now - 8 * 86400000, "approved", now - 7 * 86400000).lastInsertRowid);
    db.prepare("INSERT INTO account_invites(token,email,username,account_request_id,created_at,expires_at) VALUES(?,?,?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), `${username}@example.com`, username, requestId, now - 7 * 86400000, now - 86400000);
    db.prepare("UPDATE account_requests SET invite_id=(SELECT id FROM account_invites WHERE account_request_id=?) WHERE id=?").run(requestId, requestId);
  } finally {
    db.close();
  }
  return `${base}/join?token=${token}`;
}

for (const [name, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`Join as its board on a ${name}`, async ({ browser }) => {
    const setup = await fresh(browser);
    const link = await approvedInvite(setup, `board${name}${randomBytes(2).toString("hex")}`);
    await setup.context().close();
    const page = await fresh(browser, viewport);
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    const column = await expectPageFrame(page, "Create your account", viewport);
    const invite = page.getByRole("list", { name: "Your invite" });
    const row = invite.getByRole("listitem");
    expect((await box(row)).height).toBe(52);
    expect((await box(invite)).width).toBe(column.width);
    await expect(page.getByText("From your invite.")).toBeVisible();
    await expect(page.getByText("At least 8 characters.")).toBeVisible();
    const password = page.getByLabel("Password", { exact: true });
    const confirm = page.getByLabel("Confirm password");
    const main = page.getByRole("button", { name: "Create account" });
    for (const control of [password, confirm, page.getByRole("button", { name: "Show password" }), main]) expect((await box(control)).height).toBe(44);
    expect((await box(main)).width).toBe(column.width);
    expect((await box(confirm)).width).toBe(column.width);
    await expect(page.getByRole("button", { name: "Show password" })).toHaveCount(1);
    await expectStacked([page.locator(".signin-brand"), page.getByRole("heading", { name: "Create your account" }), page.locator(".part-group-block"), page.locator(".signin-form")]);
    mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: `artifacts/join-${name}.png` });
    await page.context().close();
  });

  test(`a link that does not work as its board on a ${name}`, async ({ browser }) => {
    const page = await fresh(browser, viewport);
    await page.goto(expiredInvite());
    await expect(page.getByRole("heading", { name: "This invite link has expired" })).toBeVisible();
    const column = await expectPageFrame(page, "This invite link has expired", viewport);
    const line = page.getByText("Ask the administrator for a new link.");
    const back = page.getByRole("button", { name: "Go to sign in" });
    expect((await box(back)).height).toBe(44);
    expect((await box(back)).width).toBe(column.width);
    await expectStacked([page.getByRole("heading", { level: 1 }), line], 16);
    await expectStacked([line, back]);
    mkdirSync("artifacts", { recursive: true });
    await page.screenshot({ path: `artifacts/join-expired-${name}.png` });
    await page.context().close();
  });
}

// List 12 of the spec.
let usedLink = "";
test("an approved applicant activates through the invite link and lands signed in on the Library", async ({ browser }) => {
  const applicant = `activist${randomBytes(2).toString("hex")}`;
  const setup = await fresh(browser);
  usedLink = await approvedInvite(setup, applicant);
  await setup.context().close();
  // The applicant opens the link in a clean session, without any administrator cookie.
  const page = await fresh(browser);
  await page.goto(usedLink);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  // The username from the invite, as a fact.
  await expect(page.getByRole("list", { name: "Your invite" }).getByRole("listitem")).toHaveText(`Username${applicant}`);
  await expect(page.getByRole("textbox", { name: "Username" })).toHaveCount(0);
  const password = page.getByLabel("Password", { exact: true });
  const confirm = page.getByLabel("Confirm password");
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute("type", "password");
  // A submit without a password is refused before anything is sent.
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Passwords are at least 8 characters.")).toBeVisible();
  await password.fill("activist-password");
  await confirm.fill("activist-passwurd");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Passwords don't match.")).toBeVisible();
  // Show password shows both fields.
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(confirm).toHaveAttribute("type", "text");
  await confirm.fill("activist-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/#library$/);
  const status = await (await page.request.get(`${base}/api/auth/status`)).json();
  expect(status.authenticated).toBe(true);
  expect(status.user.username).toBe(applicant);
  await page.context().close();
});

// List 13 of the spec: each link that does not work shows its own message as the Title and the way to sign in.
test("a used, an expired, a never-issued and a tokenless link each show their own message and Go to sign in", async ({ browser }) => {
  test.skip(!usedLink, "needs the activation test's used link");
  const cases: [string, string][] = [
    [usedLink, "This invite link has already been used"],
    [expiredInvite(), "This invite link has expired"],
    [`${base}/join?token=${randomBytes(32).toString("hex")}`, "This invite link is not valid"],
    [`${base}/join`, "This invite link is missing its token"],
  ];
  for (const [link, title] of cases) {
    const page = await fresh(browser);
    await page.goto(link);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByText("Ask the administrator for a new link.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
    const back = page.getByRole("button", { name: "Go to sign in" });
    await back.click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    await page.context().close();
  }
});
