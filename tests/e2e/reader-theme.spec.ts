import { test, expect, type Page } from "@playwright/test";
import { readerFixture } from "../reader-fixture";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { defaultAppearance } from "../../src/appearance";
import { skipOnMobile } from "./mobile";
// Tapping the middle of the page shows the reader's top bar and slider.
async function showControls(page: Page) {
  const room = page.locator(".reader-room:not(.inline-reader)");
  if (await room.locator(".reader-topbar").isVisible()) return;
  const box = (await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(room.locator(".reader-topbar")).toBeVisible();
}
async function openMore(page: Page) {
  await showControls(page);
  await page.locator(".reader-room:not(.inline-reader) .reader-topbar").getByRole("button", { name: "More", exact: true }).click();
}

test("appearance presets and custom colors persist without interrupting audio", async ({
  page,
}) => {
  // On the phone projects (#587) only for what the bands change: this one measures the desktop projects' 390-wide
  // window and plays audio, which the suite's Firefox cannot (#656).
  skipOnMobile(true, "measures the 390-wide window of the desktop projects and plays audio");
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Play Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  const playing = () =>
    expect(
      page
        .locator(".player-dock")
        .getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
  await playing();
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  // Settings › Appearance saves a theme when it is chosen (#579).
  await page.getByRole("button", { name: /^Appearance\b/ }).click();
  const chooseTheme = async (name: string) => {
    await page.getByRole("button", { name: /^Theme\b/ }).click();
    await page.getByRole("dialog", { name: "Theme", exact: true }).getByRole("radio", { name, exact: true }).click();
  };
  await chooseTheme("Light");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(245, 244, 240)",
  );
  await playing();
  await expect
    .poll(async () => (await (await page.request.get("/api/appearance")).json()).preset)
    .toBe("light");
  await page.reload();
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(245, 244, 240)",
  );
  await chooseTheme("AMOLED");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  for (let i = 0; i < 6; i++)
    await page.getByRole("button", { name: "Larger text", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Text size", exact: true })).toHaveText("130%");
  await expect
    .poll(async () => (await (await page.request.get("/api/appearance")).json()).scale)
    .toBe(1.3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: "artifacts/appearance-mobile.png",
    fullPage: true,
  });
  await page.request.put("/api/appearance", { data: defaultAppearance });
});
test("EPUB reader supports safe content, persistent positions, bookmarks, local sync and offline reopening", async ({
  page,
  context,
}) => {
  test.skip(test.info().project.name === "mobile-firefox", "plays audio, which the suite's Firefox cannot (#656)");
  const audio = await page.request.post("/api/import", {
    multipart: {
      title: "Reader companion",
      author: "Lewis Carroll",
      files: {
        name: "Down the Rabbit-Hole.mp3",
        mimeType: "audio/mpeg",
        buffer: readFileSync("server/demo/alice-01.mp3"),
      },
    },
  });
  expect(audio.ok()).toBe(true);
  const bookId = (await audio.json()).id;
  const books = await (await page.request.get("/api/books")).json();
  const audioBook = books.find((book: any) => book.id === bookId);
  const upload = await page.request.post(
    `/api/ebooks/import?workId=${audioBook.workId}`,
    {
      multipart: {
        file: {
          name: "Reader companion.epub",
          mimeType: "application/epub+zip",
          buffer: await readerFixture({ script: true }),
        },
      },
    },
  );
  expect(upload.ok()).toBe(true);
  const id = (await upload.json()).id;
  await page.goto(`/#reader/${id}`);
  await expect(
    page.getByRole("dialog", { name: "Reader" }),
  ).toBeVisible();
  const frame = page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe");
  await expect(
    frame.getByText("Alice was beginning to get very tired", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__epubScriptExecuted),
  ).toBeUndefined();
  // reader-frame.spec.ts checks the frame's sandbox and that EPUB scripts stay blocked in every engine.
  await page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("body").click({ position: { x: 340, y: 100 } });
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).checkpoint
          ?.revision || 0,
    )
    .toBeGreaterThan(0);
  const checkpoint = (
    await (await page.request.get(`/api/reader/${id}`)).json()
  ).checkpoint;
  await openMore(page);
  const more = page.locator(".reader-room:not(.inline-reader) .reader-more");
  await expect(more.getByRole("button", { name: "Read from audio" })).toBeVisible();
  await expect(more.getByRole("button", { name: "Listen from here" })).toBeVisible();
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Bookmark current sentence", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove bookmark from current sentence", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await openMore(page);
  await more.getByRole("button", { name: "Bookmarks", exact: true }).click();
  await expect(page.locator(".reader-room:not(.inline-reader) .reader-bookmark")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).checkpoint
          .locator.cfi,
    )
    .toBe(checkpoint.locator.cfi);
  await page.setViewportSize({ width: 430, height: 844 });
  await expect(page.locator(".reader-room:not(.inline-reader) .reader-viewport iframe")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Reader appearance", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Reader page theme" })
    .selectOption("sepia");
  await page
    .getByRole("slider", { name: "Reader text size", exact: true })
    .fill("23");
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
  // Linking queued a backfill job; cancel it so the manual pairing flow starts from "Rebuild".
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/alignments?ebookId=${id}`)).json()).jobs.length,
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
  const autoJob = (await (await page.request.get(`/api/alignments?ebookId=${id}`)).json()).jobs[0];
  expect(
    (await page.request.patch(`/api/alignments/${autoJob.id}`, { data: { action: "cancel" } })).ok(),
  ).toBe(true);
  await openMore(page);
  await more.getByRole("button", { name: "Reading sync", exact: true }).click();
  const sameRelease = page.getByRole("combobox", {
    name: "Reading sync audiobook release",
  });
  const chosenRecording = await sameRelease.inputValue();
  await sameRelease.selectOption(chosenRecording);
  await sameRelease.selectOption("");
  await sameRelease.selectOption(chosenRecording);
  await page
    .getByText("Match ebook sections to audio chapters", { exact: true })
    .click();
  await page
    .getByRole("combobox", {
      name: "Audio for Down the Rabbit-Hole",
      exact: true,
    })
    .selectOption({ index: 1 });
  await expect(
    page.getByRole("button", { name: "Rebuild reading sync", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Rebuild reading sync", exact: true })
    .click();
  await expect(page.locator(".reader-room:not(.inline-reader) .alignment-status")).toContainText(
    "Partial alignment",
    { timeout: 15000 },
  );
  const alignment = (
    await (await page.request.get(`/api/alignments?ebookId=${id}`)).json()
  ).jobs[0];
  await page.request.patch(`/api/alignments/${alignment.id}`, {
    data: { action: "pause" },
  });
  await expect(page.locator(".reader-room:not(.inline-reader) .alignment-status")).toContainText("Paused");
  await page
    .getByRole("button", { name: "Rebuild reading sync", exact: true })
    .click();
  await expect(page.locator(".reader-room:not(.inline-reader) .alignment-status")).toContainText(
    "Partial alignment",
  );
  await expect(page.getByRole("button", { name: "Mark alignment reviewed", exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
  await page.getByRole("button", { name: "Chapters", exact: true }).click();
  await page
    .getByRole("button", { name: "Down the Rabbit-Hole", exact: true })
    .click();
  const sentence = page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("p").first();
  const box = (await sentence.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 10);
  await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
  // Long-press plays the narration from that sentence.
  await expect(page.getByRole("status").filter({ hasText: "Listening from here" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pause narration", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pause narration", exact: true })
    .click();
  // The reader keeps the EPUB it opened on this device by itself; the More sheet's "Save ebook offline" went to the
  // Book page's Keep on this device (#532).
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const request = indexedDB.open("sonder");
            request.onsuccess = () => {
              const keys = request.result.transaction("preferences").objectStore("preferences").getAllKeys();
              keys.onsuccess = () => resolve(keys.result.some((key) => String(key).startsWith("reader-file:")));
            };
          }),
      ),
    )
    .toBe(true);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await page.screenshot({ path: "artifacts/reader-mobile.png" });
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("body"),
  ).toBeVisible();
  await openMore(page);
  await expect(page.getByRole("button", { name: "Save ebook offline", exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Close reader options", exact: true })
    .click();
  await expect(
    page.locator(
      '.reader-room:not(.inline-reader) .reading-sync select[aria-label="Reading sync audiobook release"]',
    ),
  ).toHaveValue(chosenRecording);
  await page.frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe").locator("body").click({ position: { x: 340, y: 100 } });
  await showControls(page);
  await page
    .getByRole("button", { name: "Bookmark current sentence", exact: true })
    .click();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).bookmarks
          .length,
    )
    .toBe(2);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).checkpoint
          .revision,
    )
    .toBeGreaterThan(checkpoint.revision);
  expect(checkpoint.locator.paragraphId).toMatch(/^0:/);
});
test("an image-only cover opens at the first readable EPUB section on a narrow phone", async ({
  page,
}) => {
  const upload = await page.request.post("/api/ebooks/import", {
    multipart: {
      file: {
        name: "Image cover reader.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture({ cover: true }),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const { id } = await upload.json();
  const book = await (await page.request.get(`/api/reader/${id}`)).json();
  expect(book.sections[0].index).toBe(1);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`/#reader/${id}`);
  await expect(
    page
      .frameLocator(".reader-room:not(.inline-reader) .reader-viewport iframe")
      .getByText("Alice was beginning to get very tired", { exact: false }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await showControls(page);
  expect(
    (await page
      .getByRole("button", { name: "Search this book", exact: true })
      .boundingBox())!.width,
  ).toBeGreaterThanOrEqual(44);
});
test("a bookmark the server rejects is dropped with a notice and later bookmarks still sync", async ({
  page,
}) => {
  const upload = await page.request.post("/api/ebooks/import", {
    multipart: {
      file: {
        name: "Rejected bookmark.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture(),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const { id } = await upload.json();
  // Temporary server and I/O errors keep the bookmark queued; a permanent
  // validation error drops it so later bookmarks can still sync.
  let rejected = "";
  const temporary = [
    { status: 503, json: { error: "The media drive is not available." } },
    { status: 400, json: { error: "ENOENT: no such file or directory" } },
  ];
  let transientForSecond = true;
  await page.route(`**/api/reader/${id}/bookmarks`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const bookmark = route.request().postDataJSON()?.id;
    rejected ||= bookmark;
    if (bookmark === rejected) {
      const next = temporary.shift();
      if (next) return route.fulfill(next);
      return route.fulfill({
        status: 400,
        json: { error: "This bookmark does not belong to this edition." },
      });
    }
    if (transientForSecond) {
      transientForSecond = false;
      return route.fulfill({
        status: 503,
        json: { error: "The media drive is not available." },
      });
    }
    return route.continue();
  });
  await page.goto(`/#reader/${id}`);
  const reader = page.getByRole("dialog", { name: "Reader" });
  await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
  await showControls(page);
  const add = reader.getByRole("button", {
    name: "Bookmark current sentence",
    exact: true,
  });
  await add.click();
  // The refusal is said in the foot (#591), not in the app's toast over the text.
  const refused = reader.locator('.reader-message[data-kind="error"]');
  await expect.poll(() => temporary.length).toBe(1);
  await expect(refused).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => temporary.length).toBe(0);
  await expect(refused).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(refused.getByRole("alert")).toHaveText("The bookmark could not be saved.");
  await expect(page.locator(".toast.error")).toHaveCount(0);
  await refused.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(refused).toHaveCount(0);
  await add.click();
  await expect.poll(() => transientForSecond).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).bookmarks
          .length,
    )
    .toBe(1);
  await page.unrouteAll({ behavior: "wait" });
});
test("a reader setting does not save an appearance preview", async ({
  page,
}) => {
  await page.request.put("/api/appearance", { data: defaultAppearance });
  try {
    const upload = await page.request.post("/api/ebooks/import", {
      multipart: {
        file: {
          name: "Preview reader.epub",
          mimeType: "application/epub+zip",
          buffer: await readerFixture(),
        },
      },
    });
    const { id } = await upload.json();
    // A playback setting saved from Settings › Playback (#579) leaves the app's look as it was stored.
    await page.goto("/#settings/playback");
    await page
      .getByRole("radiogroup", { name: "Progress bar shows", exact: true })
      .getByRole("radio", { name: "Current chapter", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/appearance")).json()).playback
            .progressScope,
      )
      .toBe("chapter");
    expect(
      (await (await page.request.get("/api/appearance")).json()).preset,
    ).toBe(defaultAppearance.preset);
    await page.evaluate((id) => {
      window.dispatchEvent(
        new CustomEvent("sonder:open-reader", { detail: { id, fromAudio: false } }),
      );
      location.hash = `reader/${id}`;
    }, id);
    const reader = page.getByRole("dialog", { name: "Reader" });
    await expect(reader.locator(".reader-viewport iframe")).toBeVisible();
    await showControls(page);
    await reader
      .getByRole("button", { name: "Reader appearance", exact: true })
      .click();
    await reader
      .getByRole("slider", { name: "Reader text size", exact: true })
      .fill("23");
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/appearance")).json()).reader
            .size,
      )
      .toBe(23);
    expect(
      (await (await page.request.get("/api/appearance")).json()).preset,
    ).toBe(defaultAppearance.preset);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      defaultAppearance.preset,
    );
  } finally {
    await page.request.put("/api/appearance", { data: defaultAppearance });
  }
});
test("startup does not write another user's cached appearance into the admin's storage", async ({
  page,
}) => {
  const light = { ...defaultAppearance, preset: "light" };
  const amoled = { ...defaultAppearance, preset: "amoled" };
  await page.addInitScript(
    ([light, amoled]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      // The admin keeps a device-only look; user 2 was the last one in this tab.
      localStorage.setItem("sonder-appearance", JSON.stringify(light));
      localStorage.setItem("sonder-appearance-device", "true");
      localStorage.setItem("sonder-user-2:sonder-appearance", JSON.stringify(amoled));
      sessionStorage.setItem("sonder-current-user", "2");
    },
    [light, amoled],
  );
  try {
    await page.goto("/");
    // The test server signs everyone in as the admin.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("sonder-appearance") || "{}").preset,
      ),
    ).toBe("light");
  } finally {
    await page.evaluate(() => {
      localStorage.removeItem("sonder-appearance");
      localStorage.removeItem("sonder-appearance-device");
      localStorage.removeItem("sonder-user-2:sonder-appearance");
    });
  }
});
test("Keep my place while offline keeps the conflict until reconnected and then resolves it", async ({
  page,
  context,
}) => {
  const upload = await page.request.post("/api/ebooks/import", {
    multipart: {
      file: {
        name: "Offline conflict.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture(),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const { id } = await upload.json();
  await page.goto(`/#reader/${id}`);
  const reader = page.getByRole("dialog", { name: "Reader" });
  const frame = reader.frameLocator(".reader-viewport iframe");
  await expect(
    frame.getByText("Alice was beginning to get very tired", { exact: false }),
  ).toBeVisible();
  const remote = await page.request.put(`/api/reader/${id}/progress`, {
    data: {
      locator: {
        section: 1,
        paragraphId: "1:0",
        quote: "Other session",
        progression: 0.5,
      },
      baseRevision: 0,
      // Event ids are unique per user across every book, as the client's randomUUID ids are; a fixed id
      // would be refused when the test repeats on the same server.
      eventId: `remote-conflict-${randomUUID()}`,
      deviceId: "other-device",
      updatedAt: Date.now(),
      origin: "reading",
    },
  });
  expect(remote.ok()).toBe(true);
  await frame.locator("body").click({ position: { x: 340, y: 100 } });
  // The conflict is the foot's message (#591); Stay is today's Keep my place.
  const conflict = reader.locator('.reader-message[data-kind="conflict"]');
  await expect(conflict).toBeVisible();
  await context.setOffline(true);
  try {
    await conflict
      .getByRole("button", { name: "Stay here", exact: true })
      .click();
    await expect(conflict).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(conflict).toBeHidden();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).checkpoint
          ?.revision,
    )
    .toBe(2);
});
test("a 409 with no server checkpoint rebases to revision 0 and saves instead of looping", async ({
  page,
}) => {
  const upload = await page.request.post("/api/ebooks/import", {
    multipart: {
      file: {
        name: "Inherited revision.epub",
        mimeType: "application/epub+zip",
        buffer: await readerFixture(),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const { id } = await upload.json();
  // Seed an inherited local reading state with baseRevision > 0 while the
  // server has no checkpoint for this book.
  await page.goto("/");
  await page.evaluate((id) => {
    localStorage.setItem(
      `reader-position:${id}`,
      JSON.stringify({
        checkpoint: {
          locator: {
            section: 1,
            paragraphId: "1:0",
            quote: "Inherited place",
            progression: 0,
          },
          revision: 4,
          eventId: "inherited-event",
          deviceId: "inherited-device",
          updatedAt: Date.now() - 1000,
          origin: "reading",
        },
        baseRevision: 4,
        pending: false,
      }),
    );
  }, id);
  await page.goto(`/#reader/${id}`);
  const reader = page.getByRole("dialog", { name: "Reader" });
  const frame = reader.frameLocator(".reader-viewport iframe");
  await expect(
    frame.getByText("Alice was beginning to get very tired", { exact: false }),
  ).toBeVisible();
  await frame.locator("body").click({ position: { x: 340, y: 100 } });
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/reader/${id}`)).json()).checkpoint
          ?.revision,
    )
    .toBe(1);
  await expect(reader.locator('.reader-message[data-kind="conflict"]')).toBeHidden();
});
// The view choice is gone from Settings (ADR 0017); a choice saved by an older client stays stored, ignored.
test("Settings → Playback offers no ebook view and saving it keeps a stored view choice", async ({
  page,
}) => {
  const appearance = await (await page.request.get("/api/appearance")).json();
  try {
    await page.request.put("/api/appearance", {
      data: { ...appearance, reader: { ...appearance.reader, display: "segment" } },
    });
    // Settings › Playback saves a change at once (#579).
    await page.goto("/#settings/playback");
    const scope = page.getByRole("radiogroup", { name: "Progress bar shows", exact: true });
    await expect(scope).toBeVisible();
    await expect(page.getByText("Ebook view")).toHaveCount(0);
    const saved = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.url().endsWith("/api/appearance"),
    );
    const other = appearance.playback.progressScope === "chapter" ? "Whole audiobook" : "Current chapter";
    await scope.getByRole("radio", { name: other, exact: true }).click();
    expect((await saved).ok()).toBe(true);
    expect((await (await page.request.get("/api/appearance")).json()).reader.display).toBe("segment");
  } finally {
    await page.request.put("/api/appearance", { data: appearance });
  }
});
