import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

test("changing a precached public asset changes the shell version", async () => {
  const root = await mkdtemp(join(tmpdir(), "sonder-sw-test-"));
  try {
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "public"));
    await copyFile(resolve("public/sw.js"), join(root, "public/sw.js"));
    await writeFile(join(root, "dist/index.html"), "same shell");
    await writeFile(join(root, "dist/manifest.webmanifest"), "old");
    const build = () => execFileSync(process.execPath, [resolve("scripts/build-sw.mjs")], { cwd: root });
    build();
    const first = await readFile(join(root, "dist/sw.js"), "utf8");
    await writeFile(join(root, "dist/manifest.webmanifest"), "new");
    build();
    expect(await readFile(join(root, "dist/sw.js"), "utf8")).not.toBe(first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("media location responses do not enter the stream cache", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const books = await (await page.request.get("/api/books")).json();
  const track = books.find((book: any) => book.tracks.length)?.tracks[0];
  expect(track).toBeTruthy();
  await page.evaluate(async (id) => {
    await caches.delete("sonder-stream-v1");
    await fetch(`/api/media/${encodeURIComponent(id)}/location?source=auto`);
  }, track.id);
  const urls = await page.evaluate(async () => (await (await caches.open("sonder-stream-v1")).keys()).map(r => r.url));
  expect(urls.some(url => url.includes("/location"))).toBe(false);
});
