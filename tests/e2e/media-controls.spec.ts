import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseRange } from "../../server/range";
import { readerFixture } from "../reader-fixture";
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
      const states: MediaPositionState[] = [];
      (window as any).__positionStates = states;
      const report = navigator.mediaSession.setPositionState?.bind(navigator.mediaSession);
      if (report)
        navigator.mediaSession.setPositionState = (state?: MediaPositionState) => {
          if (state) states.push({ ...state });
          report(state);
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
  // The lock-screen scrubber gets the position after the remote seeks and the element's real rate.
  const lockScreen = await page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find(
      (audio) => !!audio.src,
    )!;
    return {
      state: ((window as any).__positionStates as MediaPositionState[]).at(-1),
      rate: audio.playbackRate,
    };
  });
  expect(lockScreen.state?.position).toBeCloseTo(100, 0);
  expect(lockScreen.state?.playbackRate).toBe(lockScreen.rate);
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
test("Space toggles playback across views and arrows skip 30 seconds while ignoring inputs, buttons and dialogs", async ({
  page,
}) => {
  await instrument(page);
  const paused = () =>
    page.evaluate(
      () =>
        ((window as any).__audioElements as HTMLAudioElement[]).find(
          (audio) => !!audio.src,
        )?.paused ?? true,
    );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your library." }),
  ).toBeVisible();
  // Space with no audio loaded does nothing and shows no error.
  await page.keyboard.press(" ");
  expect(await paused()).toBe(true);
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
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  // Space on the library pauses and resumes playback.
  await page.keyboard.press(" ");
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  expect(await paused()).toBe(true);
  await page.keyboard.press(" ");
  await expect(
    page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  expect(await paused()).toBe(false);
  await page.keyboard.press(" ");
  expect(await paused()).toBe(true);
  await page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find(
      (audio) => !!audio.src,
    )!;
    audio.currentTime = 100;
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(130, 0);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(100, 0);
  // Typing in the search box does not toggle playback or seek.
  const search = page.getByRole("textbox", {
    name: "Search your library",
    exact: true,
  });
  await search.focus();
  await page.keyboard.type("wonder land");
  await expect(search).toHaveValue("wonder land");
  expect(await paused()).toBe(true);
  await search.fill("");
  // Space on a title page toggles playback.
  await page
    .getByRole("button", {
      name: "Open title page for Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Book details", exact: true }),
  ).toBeVisible();
  await page.keyboard.press(" ");
  await expect.poll(paused).toBe(false);
  await page.keyboard.press(" ");
  await expect.poll(paused).toBe(true);
  // On the Audiobook page (#530) Space toggles playback, and is ignored while its picker, a dialog of a copy or the
  // note of Report a problem has focus.
  await page
    .getByRole("dialog", { name: "Book details", exact: true })
    .getByRole("button", { name: /^Audiobook / })
    .click();
  const audiobook = page.getByRole("region", { name: "Audiobook", exact: true });
  await expect(audiobook).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(" ");
  await expect.poll(paused).toBe(false);
  await page.keyboard.press(" ");
  await expect.poll(paused).toBe(true);
  // Back to the place the arrows are measured from below: the page played for a moment.
  await page.evaluate(() => {
    const audio = ((window as any).__audioElements as HTMLAudioElement[]).find((item) => !!item.src)!;
    audio.currentTime = 100;
  });
  await expect.poll(() => audioPosition(page)).toBeCloseTo(100, 0);
  await audiobook.getByRole("button", { name: /^Plays from: / }).click();
  const picker = page.getByRole("dialog", { name: "Plays from", exact: true });
  await expect(picker).toBeVisible();
  await page.keyboard.press(" ");
  expect(await paused()).toBe(true);
  await picker.getByRole("button", { name: "Close dialog", exact: true }).click();
  await audiobook.getByRole("button", { name: /^Original stream / }).click();
  const copy = page.getByRole("dialog", { name: "Original stream", exact: true });
  await expect(copy).toBeVisible();
  await page.keyboard.press(" ");
  expect(await paused()).toBe(true);
  await copy.getByRole("button", { name: "Close dialog", exact: true }).click();
  await audiobook.getByRole("button", { name: "Report a problem", exact: true }).click();
  const note = page.getByRole("dialog", { name: "Report a problem", exact: true }).getByRole("textbox", { name: "Note", exact: true });
  await expect(note).toBeFocused();
  await page.keyboard.press(" ");
  await expect(note).toHaveValue(" ");
  expect(await paused()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(note).toBeHidden();
  await page.goBack();
  await expect(audiobook).toBeHidden();
  await page
    .getByRole("dialog", { name: "Book details", exact: true })
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  // Space and arrows work in Now Playing.
  await page.locator(".dock-book").click();
  const nowPlaying = page.getByRole("dialog", {
    name: "Now playing",
    exact: true,
  });
  await expect(nowPlaying).toBeVisible();
  await page.keyboard.press(" ");
  await expect(
    nowPlaying.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  expect(await paused()).toBe(false);
  await page.keyboard.press(" ");
  await expect(
    nowPlaying.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  expect(await paused()).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(130, 0);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => audioPosition(page)).toBeCloseTo(100, 0);
  await nowPlaying
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  // Space and arrows also work in the Now Playing reader in Page mode.
  const imported = await page.request.post("/api/import", {
    multipart: {
      title: "Keyboard reader book",
      author: "Reader QA",
      file: {
        name: "Chapter.mp3",
        mimeType: "audio/mpeg",
        buffer: readFileSync("server/demo/alice-01.mp3"),
      },
    },
  });
  expect(imported.ok()).toBe(true);
  const { id } = await imported.json();
  try {
    const book = (await (await page.request.get("/api/books")).json()).find(
      (b: any) => b.id === id,
    );
    expect(
      (
        await page.request.post(`/api/ebooks/import?workId=${book.workId}`, {
          multipart: {
            file: {
              name: "Companion.epub",
              mimeType: "application/epub+zip",
              buffer: await readerFixture(),
            },
          },
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
    await page
      .getByRole("button", { name: "Play Keyboard reader book", exact: true })
      .click();
    await page
      .locator(".player-dock")
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await page.locator(".dock-book").click();
    await expect(
      page.locator(".inline-reader .reader-viewport iframe"),
    ).toBeVisible();
    await page.keyboard.press(" ");
    await expect(
      nowPlaying.getByRole("button", { name: "Pause narration", exact: true }),
    ).toBeVisible();
    expect(await paused()).toBe(false);
    await page.keyboard.press(" ");
    await expect(
      nowPlaying.getByRole("button", { name: "Play narration", exact: true }),
    ).toBeVisible();
    expect(await paused()).toBe(true);
    const readerStart = await audioPosition(page);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => audioPosition(page)).toBeCloseTo(readerStart + 30, 0);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => audioPosition(page)).toBeCloseTo(readerStart, 0);
  } finally {
    await page.request.delete(`/api/library/${id}`);
  }
});
test("keyboard shortcut sheet opens from Now Playing and Settings", async ({ page }) => {
  await instrument(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Play Alice’s Adventures in Wonderland", exact: true })
    .click();
  await page.locator(".dock-book").click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(sheet).toBeVisible();
  for (const action of ["Play or pause", "Skip 30 seconds back or forward", "Search", "Follow the audio in the reader"])
    await expect(sheet.getByText(action, { exact: true })).toBeVisible();
  for (const key of ["Space", "←", "→", "/", "f"])
    await expect(sheet.locator("kbd", { hasText: new RegExp(`^${key === "/" ? "\\/" : key}$`) })).toBeVisible();
  // The reader has one view (ADR 0017): no view switch and no `p` key are listed.
  await expect(sheet.getByText(/Page view|Lyrics|Word view/)).toHaveCount(0);
  await expect(sheet.locator("kbd", { hasText: /^p$/i })).toHaveCount(0);
  await expect(sheet.locator("kbd")).toHaveCount(5);
  await sheet.getByRole("button", { name: "Close dialog" }).click();
  await expect(sheet).toBeHidden();
  await page.goto("/#settings/playback");
  // The new address closes Now playing (it has a history entry of its own, #484); its button may still be on
  // screen while it closes, so this is the Settings page's own (Settings › Playback, #579).
  await page.locator("main").getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }).getByText("Play or pause")).toBeVisible();
});
test("a form dialog focuses its first text field when it opens", async ({ page }) => {
  await page.goto("/#settings/connections");
  await page.getByRole("textbox", { name: /^API token/ }).fill("browser-test-token");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Hardcover sync mode", exact: true })).toBeEnabled();
  await page.goto("/#library");
  await page.getByRole("button", { name: "About Frankenstein", exact: true }).click();
  await page.getByRole("button", { name: /Match on Hardcover/ }).click();
  await expect(page.getByRole("textbox", { name: "Match book title and author" })).toBeFocused();
});
