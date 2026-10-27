import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseRange } from "../../server/range";
test.use({ serviceWorkers: "block" });
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const audio: HTMLAudioElement[] = [];
    (window as any).__audioElements = audio;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        audio.push(this);
      }
    };
    const handlers: Record<string, any> = {};
    (window as any).__mediaHandlers = handlers;
    if ("mediaSession" in navigator) {
      const native = navigator.mediaSession.setActionHandler.bind(
        navigator.mediaSession,
      );
      navigator.mediaSession.setActionHandler = (action, handler) => {
        handlers[action] = handler;
        native(action, handler);
      };
    }
  });
}
async function remote(page: Page, action: string) {
  await page.evaluate(
    (action) => (window as any).__mediaHandlers[action]({ action }),
    action,
  );
}
async function audioPosition(page: Page) {
  return page.evaluate(
    () =>
      ((window as any).__audioElements as HTMLAudioElement[]).find(
        (audio) => !!audio.src,
      )!.currentTime,
  );
}
test("onscreen, lock-screen and headphone commands seek 30 seconds and persist their position", async ({
  page,
}) => {
  await instrument(page);
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Play Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await expect(
    page.locator(".player-dock").getByLabel("Playback source"),
  ).toHaveText("Host server");
  await page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find(
      (audio) => !!audio.src,
    )!;
    audio.currentTime = 100;
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await remote(page, "nexttrack");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(130, 0);
  await remote(page, "previoustrack");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(100, 0);
  await remote(page, "seekforward");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(130, 0);
  await remote(page, "seekbackward");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(100, 0);
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Rewind 30 seconds", exact: true })
    .click();
  await expect.poll(() => audioPosition(page)).toBeCloseTo(70, 0);
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Forward 30 seconds", exact: true })
    .click();
  await expect.poll(() => audioPosition(page)).toBeCloseTo(100, 0);
  await expect
    .poll(async () => {
      const books = await (await page.request.get("/api/books")).json();
      return books.find((book: any) => book.id === "alice").progress.position;
    })
    .toBeCloseTo(100, 0);
  await expect(
    page.getByRole("button", { name: "Next chapter", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});
test("headphone seeks cross audio files while paused and retain the 30-second offset", async ({
  page,
}) => {
  await instrument(page);
  const audio = readFileSync("server/demo/alice-01.mp3");
  await page.route("**/api/media/alice-1", (route) => {
    const range = parseRange(route.request().headers()["range"], audio.length);
    if (range === "invalid") return route.fulfill({ status: 416 });
    const start = range?.start || 0,
      end = range?.end ?? audio.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      body: audio.subarray(start, end + 1),
      headers: {
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        ...(range
          ? { "Content-Range": `bytes ${start}-${end}/${audio.length}` }
          : {}),
      },
    });
  });
  await page.route("**/api/books", async (route) => {
    const response = await route.fetch();
    const books = await response.json();
    const alice = books.find((book: any) => book.id === "alice");
    alice.tracks = alice.tracks.slice(0, 2);
    alice.tracks[1].duration = alice.tracks[0].duration;
    await route.fulfill({ response, json: books });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Play Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  const length = await page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find(
      (audio) => !!audio.src,
    )!;
    audio.currentTime = audio.duration - 10;
    audio.dispatchEvent(new Event("timeupdate"));
    return audio.duration;
  });
  await remote(page, "nexttrack");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          ((window as any).__audioElements as HTMLAudioElement[]).find(
            (audio) => !!audio.src,
          )!.src,
      ),
    )
    .toContain("/api/media/alice-1");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(20, 0);
  expect(
    await page.evaluate(
      () =>
        ((window as any).__audioElements as HTMLAudioElement[]).find(
          (audio) => !!audio.src,
        )!.paused,
    ),
  ).toBe(true);
  await remote(page, "previoustrack");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          ((window as any).__audioElements as HTMLAudioElement[]).find(
            (audio) => !!audio.src,
          )!.src,
      ),
    )
    .toContain("/api/media/alice-0");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(length - 10, 0);
});
