import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";

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
// The port can be taken between freePort() closing its probe and the server binding it, so retry on a new port.
test.beforeAll(async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], { env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: String(port) }, stdio: "ignore" });
    for (let i = 0; i < 100 && server.exitCode === null; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    server.kill();
  }
  throw new Error("Authenticated browser server did not start");
});
test.afterAll(() => { server?.kill(); });
test("an unauthenticated visitor can request an account from the sign-in page", async ({ page }) => {
  mkdirSync("artifacts", { recursive: true });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Request an account" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Request an account" });
  await expect(dialog).toBeVisible();
  // The hidden honeypot is rendered but unreachable by a person.
  await expect(dialog.getByLabel("Website")).toHaveAttribute("tabindex", "-1");
  // Invalid formats are refused client-side before anything is sent.
  await dialog.getByLabel("Email").fill("not-an-email");
  await dialog.getByLabel("Username").fill("a");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog.getByText("Enter a valid email address.")).toBeVisible();
  await expect(dialog.getByText("Usernames are 2 to 40 characters.")).toBeVisible();
  await dialog.getByLabel("Email").fill("bradley@example.com");
  await dialog.getByLabel("Username").fill("bradley");
  await dialog.getByLabel("Note optional").fill("Just want access for a while");
  await page.screenshot({ path: "artifacts/account-request-dialog.png" });
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog.getByRole("status").getByText("Your request has been received. Thank you!")).toBeVisible();
  await page.screenshot({ path: "artifacts/account-request-confirmed.png" });
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});
test("the administrator sees the pending account request in Settings", async ({ page }) => {
  mkdirSync("artifacts", { recursive: true });
  await page.goto(base);
  await page.getByLabel("Password", { exact: true }).fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  const users = page.locator("section").filter({ has: page.getByRole("heading", { name: "Users" }) });
  await expect(users.getByRole("heading", { name: "Pending account requests" })).toBeVisible();
  const row = users.getByRole("listitem").filter({ hasText: "bradley@example.com" });
  await expect(row.getByText("bradley", { exact: true })).toBeVisible();
  await expect(row.getByText("Just want access for a while")).toBeVisible();
  await page.screenshot({ path: "artifacts/account-request-queue.png" });
});
