// @projects firefox, mobile-chrome, mobile-firefox, mobile-safari, mobile-iphone-slice13-sw, webkit-iphone-now-playing, mobile-iphone-slice14
import { test, expect, type Page } from "@playwright/test";
import { readerFixture } from "../reader-fixture";
import { randomUUID } from "node:crypto";
import { defaultAppearance } from "../../src/appearance";
import { skipOnMobile } from "./mobile";
import { openAppearance, setStepper } from "./reader-appearance";
import { playFromLibrary } from "./library-play";
import { gotoRead } from "./read-face";
import { bookText, bookTextIn, textFrame, bookBody } from "./reader-view";
// Tapping the middle of the page shows the reader's top bar and slider.
async function showControls(page: Page) {
  const room = page.locator(".reader-room");
  if (await room.locator(".reader-topbar").isVisible()) return;
  const box = (await room.locator(".reader-viewport").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(room.locator(".reader-topbar")).toBeVisible();
}

test("appearance presets and custom colors persist without interrupting audio", async ({
  page,
}) => {
  // On the phone projects (#587) only for what the bands change: this one measures the desktop projects' 390-wide
  // window and plays audio, which the suite's Firefox cannot (#656).
  skipOnMobile(true, "measures the 390-wide window of the desktop projects and plays audio");
  await page.goto("/");
  await playFromLibrary(page, "Alice’s Adventures in Wonderland");
  const playing = () =>
    expect(
      page
        .locator(".player-dock")
        .getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
  await playing();
  await page
    .getByRole("navigation", { name: "Main", exact: true })
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
  await gotoRead(page, id);
  await expect(
    bookText(page)
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
  await gotoRead(page, id);
  const reader = page.getByRole("dialog", { name: "Now playing", exact: true });
  await expect(textFrame(reader)).toBeVisible();
  await showControls(page);
  // A book with only this ebook reads in Now playing's Read face with no narration (#594): the head bookmarks the
  // page's first sentence.
  const add = reader.getByRole("button", {
    name: "Bookmark the first sentence on this page",
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
    const reader = page.getByRole("dialog", { name: "Now playing", exact: true });
    await expect(textFrame(reader)).toBeVisible();
    await showControls(page);
    // From Appearance docked under the text (#588).
    const room = reader.locator(".reader-room");
    await openAppearance(page, room);
    await setStepper(room, "Size", 23);
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
  await gotoRead(page, id);
  const reader = page.getByRole("dialog", { name: "Now playing", exact: true });
  const frame = bookTextIn(reader);
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
  await bookBody(frame).click({ position: { x: 340, y: 100 } });
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
  await gotoRead(page, id);
  const reader = page.getByRole("dialog", { name: "Now playing", exact: true });
  const frame = bookTextIn(reader);
  await expect(
    frame.getByText("Alice was beginning to get very tired", { exact: false }),
  ).toBeVisible();
  await bookBody(frame).click({ position: { x: 340, y: 100 } });
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
