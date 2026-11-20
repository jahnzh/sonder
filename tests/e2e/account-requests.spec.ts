// @projects firefox, mobile-iphone-slice13
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
// A visitor's request (list 10 of spec #572) is guarded in sign-in.spec.ts; this one is sent as that sheet sends it.
test("the administrator sees the pending account request in Settings", async ({ page }) => {
  mkdirSync("artifacts", { recursive: true });
  const sent = await page.request.post(`${base}/api/account-requests`, {
    data: { email: "bradley@example.com", username: "bradley", note: "Just want access for a while", honeypot: "" },
  });
  expect(sent.ok()).toBe(true);
  await page.goto(base);
  await page.getByLabel("Password", { exact: true }).fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Settings › Users (#579).
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await page.getByRole("navigation", { name: "Settings", exact: true }).getByRole("button", { name: /^Users\b/ }).click();
  // Account requests as cards (#580): the username, the email and the note, with Decline and Approve.
  const requests = page.locator("main").getByRole("list", { name: /^Account requests · \d+$/ });
  const card = requests.getByRole("listitem", { name: "bradley", exact: true });
  await expect(card.getByText("bradley", { exact: true })).toBeVisible();
  await expect(card.getByText("bradley@example.com", { exact: true })).toBeVisible();
  await expect(card.getByText("Just want access for a while")).toBeVisible();
  await page.screenshot({ path: "artifacts/account-request-queue.png" });
  // Approving shows the invite line (moved here from join.spec.ts, whose activation is in sign-in.spec.ts).
  await card.getByRole("button", { name: "Approve" }).click();
  const line = page.locator("main").getByRole("status").filter({ hasText: "Approved bradley." });
  await expect(line).toContainText(/^Approved bradley\. The invite email was (not )?sent\./);
  await expect(line.locator("code")).toHaveText(/\/join\?token=[0-9a-f]{64}$/);
  await expect(line.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
});
