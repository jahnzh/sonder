import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";

let server: ChildProcess;
const base = "http://127.0.0.1:4174";
test.beforeAll(async () => {
  server = spawn(process.execPath, ["--import", "tsx", "tests/browser-server.ts"], { env: { ...process.env, PLAYWRIGHT_AUTH: "1", APP_PASSWORD: "admin-password", PLAYWRIGHT_PORT: "4174" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Authenticated browser server did not start");
});
test.afterAll(() => { server?.kill(); });
test("accounts keep libraries and offline queues separate", async ({ page }) => {
  mkdirSync("artifacts", { recursive: true });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.screenshot({ path: "artifacts/users-sign-in.png" });
  await page.getByLabel("Password", { exact: true }).fill("admin-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  const users = page.locator("section").filter({ has: page.getByRole("heading", { name: "Users" }) });
  await expect(users.getByLabel("Role")).toHaveCount(0);
  await users.getByLabel("Username").fill("reader");
  await users.getByLabel("Password", { exact: true }).fill("reader-password");
  await users.getByRole("button", { name: "Add user" }).click();
  await expect(users.getByRole("listitem").filter({ hasText: "reader" }).getByText("User", { exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/users-admin-settings.png" });
  const adminBooks = await (await page.request.get(`${base}/api/books`)).json();
  const book = adminBooks.find((b: { inLibrary: boolean; tracks: unknown[] }) => b.inLibrary && b.tracks.length);
  await page.evaluate(({ recordingId, trackId }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("sonder");
    request.onsuccess = () => { const tx = request.result.transaction("progress", "readwrite"); tx.objectStore("progress").put({ recordingId, trackId, position: 123, updatedAt: Date.now(), pending: true }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); };
  }), { recordingId: book.recordingId, trackId: book.tracks[0].id });
  let mismatches = 0;
  let queueOwner = "";
  await page.route("**/api/progress", route => { mismatches++; queueOwner = route.request().headers()["x-sonder-user-id"]; return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "user_mismatch", error: "Signed in as a different user." }) }); });
  await page.reload();
  await expect.poll(() => mismatches).toBeGreaterThan(0);
  expect(queueOwner).toBe("1");
  await expect.poll(() => page.evaluate((id) => new Promise<boolean>(resolve => { const request = indexedDB.open("sonder"); request.onsuccess = () => { const get = request.result.transaction("progress").objectStore("progress").get(id); get.onsuccess = () => resolve(!!get.result?.pending); }; }), book.recordingId)).toBe(true);
  await page.unroute("**/api/progress");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Username").fill("reader");
  await page.getByLabel("Password", { exact: true }).fill("reader-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "TorBox" })).toHaveCount(0);
  await page.screenshot({ path: "artifacts/users-reader-settings.png" });
  const readerBooks = await (await page.request.get(`${base}/api/books`)).json();
  expect(readerBooks.find((b: { id: string }) => b.id === book.id).inLibrary).toBe(false);
  expect(readerBooks.find((b: { id: string }) => b.id === book.id).progress?.position || 0).not.toBe(123);
  await page.getByRole("button", { name: "Discover", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Audiobooks" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ebooks" })).toHaveCount(0);
  await page.getByRole("button", { name: `Add ${book.title} to library` }).click();
  await expect.poll(async () => (await (await page.request.get(`${base}/api/books`)).json()).find((b: { id: string }) => b.id === book.id).inLibrary).toBe(true);
});
