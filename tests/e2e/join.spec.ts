import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import Database from "better-sqlite3";

// Ask the OS for a free port so this spec never collides with the shared run or another shard.
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
// The server's database lives in a spec-owned directory so the expired-invite
// test can seed it directly.
let dataDir = "";
// The port can be taken between freePort() closing its probe and the server binding it, so retry on a new port.
test.beforeAll(async () => {
  dataDir = join(mkdtempSync(join(tmpdir(), "sonder-join-e2e-")), "db");
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // APP_URL points the emailed invite link at this spec's server, so the
    // link the admin UI shows is the one the applicant actually opens.
    server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], { env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", APP_URL: base, PLAYWRIGHT_PORT: String(port), PLAYWRIGHT_DATA_DIR: dataDir }, stdio: "ignore" });
    for (let i = 0; i < 100 && server.exitCode === null; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    server.kill();
  }
  throw new Error("Authenticated browser server did not start");
});
test.afterAll(() => { server?.kill(); rmSync(join(dataDir, ".."), { recursive: true, force: true }); });
// Set by the activation test; the error-state tests reopen the same link.
let inviteLink = "";
test("an approved applicant activates through the invite link and lands signed in", async ({ browser }) => {
  mkdirSync("artifacts", { recursive: true });
  // The applicant requests an account from the sign-in page.
  const page = await (await browser.newContext()).newPage();
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Request an account" }).click();
  const dialog = page.getByRole("dialog", { name: "Request an account" });
  await dialog.getByLabel("Email").fill("activist@example.com");
  await dialog.getByLabel("Username").fill("activist");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog.getByRole("status").getByText("Your request has been received. Thank you!")).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  // The administrator approves the request and takes the invite link from the admin UI.
  await page.getByLabel("Password", { exact: true }).fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  const users = page.locator("section").filter({ has: page.getByRole("heading", { name: "Users" }) });
  await expect(users.getByRole("heading", { name: "Pending account requests" })).toBeVisible();
  const row = users.getByRole("listitem").filter({ hasText: "activist@example.com" });
  await row.getByRole("button", { name: "Approve" }).click();
  const approvalLink = users.locator(".request-approval-link");
  await expect(approvalLink).toBeVisible();
  inviteLink = (await approvalLink.innerText()).trim();
  expect(inviteLink).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/join\?token=[0-9a-f]{64}$/);
  // The applicant opens the link in a clean session, without any admin cookie.
  const joinPage = await (await browser.newContext()).newPage();
  await joinPage.goto(inviteLink);
  await expect(joinPage.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(joinPage.getByText("activist@example.com")).toBeVisible();
  const username = joinPage.getByLabel("Username");
  await expect(username).toHaveValue("activist");
  await expect(username).not.toBeEditable();
  const password = joinPage.getByLabel("Password", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  // A submit without a password is refused client-side.
  await joinPage.getByRole("button", { name: "Create account" }).click();
  await expect(joinPage.getByText("Passwords are at least 8 characters.")).toBeVisible();
  await password.fill("activist-password");
  await joinPage.getByRole("button", { name: "Show password" }).first().click();
  await expect(password).toHaveAttribute("type", "text");
  await joinPage.getByLabel("Confirm password").fill("activist-password");
  await joinPage.screenshot({ path: "artifacts/join-activation-card.png" });
  await joinPage.getByRole("button", { name: "Create account" }).click();
  // The activation signs the applicant in and lands on the bookshelf.
  await expect(joinPage.getByRole("heading", { name: "No books" })).toBeVisible();
  await expect(joinPage.getByRole("heading", { name: "Create your account" })).toHaveCount(0);
  await expect(joinPage).toHaveURL(/\/#library$/);
  const status = await (await joinPage.request.get(`${base}/api/auth/status`)).json();
  expect(status.authenticated).toBe(true);
  expect(status.user.username).toBe("activist");
  await joinPage.screenshot({ path: "artifacts/join-landed-on-bookshelf.png" });
});
test("a used invite link shows the dedicated error card and the sign-in link", async ({ browser }) => {
  mkdirSync("artifacts", { recursive: true });
  const joinPage = await (await browser.newContext()).newPage();
  await joinPage.goto(inviteLink);
  await expect(joinPage.getByRole("alert").getByText("This invite link has already been used.")).toBeVisible();
  const back = joinPage.getByRole("link", { name: "Return to sign in" });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute("href", "/");
  await joinPage.screenshot({ path: "artifacts/join-reused-error.png" });
  await back.click();
  await expect(joinPage.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
test("an expired invite link shows the dedicated error card", async ({ browser }) => {
  mkdirSync("artifacts", { recursive: true });
  // Seed the test database directly with an invite that expired a day ago.
  const token = randomBytes(32).toString("hex");
  const db = new Database(join(dataDir, "sonder.db"));
  try {
    const now = Date.now();
    db.prepare("INSERT INTO account_requests(email,username,note,created_at,status,reviewed_at) VALUES(?,?,?,?,?,?)").run("expired@example.com", "expired", null, now - 8 * 86400000, "approved", now - 7 * 86400000);
    const requestId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare("INSERT INTO account_invites(token,email,username,account_request_id,created_at,expires_at) VALUES(?,?,?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), "expired@example.com", "expired", requestId, now - 7 * 86400000, now - 86400000);
    db.prepare("UPDATE account_requests SET invite_id=(SELECT id FROM account_invites WHERE account_request_id=?) WHERE id=?").run(requestId, requestId);
  } finally {
    db.close();
  }
  const joinPage = await (await browser.newContext()).newPage();
  await joinPage.goto(`${base}/join?token=${token}`);
  await expect(joinPage.getByRole("alert").getByText("This invite link has expired.")).toBeVisible();
  await expect(joinPage.getByRole("link", { name: "Return to sign in" })).toBeVisible();
  await joinPage.screenshot({ path: "artifacts/join-expired-error.png" });
});
test("a token that was never issued shows the dedicated error card", async ({ browser }) => {
  const joinPage = await (await browser.newContext()).newPage();
  await joinPage.goto(`${base}/join?token=${randomBytes(32).toString("hex")}`);
  await expect(joinPage.getByRole("alert").getByText("This invite link is not valid.")).toBeVisible();
  await expect(joinPage.getByRole("link", { name: "Return to sign in" })).toBeVisible();
});
