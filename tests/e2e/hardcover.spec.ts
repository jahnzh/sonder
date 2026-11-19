import { test, expect } from "@playwright/test";
import { rememberAlicesPlace } from "./alice-place";
import { inSortPicker } from "./library-view";
import { connectHardcover } from "./connections";
// The first test moves the shelf book to another shelf, takes it off the list and sets Alice's Hardcover edition.
// Afterwards they go back through the same routes, so a repeat (or the next browser on this server) starts the same.
// Use Hardcover position plays Alice and so moves her saved place; it goes back to where the test found it.
let restoreAlice: (() => Promise<void>) | null = null;
test.beforeEach(async ({ page }) => {
  restoreAlice = await rememberAlicesPlace(page);
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await restoreAlice?.();
  restoreAlice = null;
  const books = await (await page.request.get("/api/books")).json();
  const shelf = books.find((b: { title: string }) => b.title === "The Quiet Shelf");
  const alice = books.find((b: { id: string }) => b.id === "alice");
  if (shelf?.hardcover) {
    await page.request.patch("/api/hardcover/shelf", { data: { workId: shelf.workId, statusId: 1 } });
    await page.request.patch("/api/hardcover/lists/8803", { data: { workId: shelf.workId, included: true } });
  }
  if (alice?.hardcover) await page.request.patch("/api/hardcover/edition", { data: { workId: alice.workId, recordingId: alice.recordingId, editionId: null } });
});
test("mobile Hardcover connection, shelves, custom lists, edition selection and two-way resume (the book's half on the Hardcover page)", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Connections (#580): the token with its own Save, then Two-way, saved when chosen.
  await page.goto("/#settings/connections");
  await connectHardcover(page, "Two-way");
  await expect(page.getByRole("listitem", { name: "Status Connected", exact: true })).toBeVisible();
  // The first sync on a server imports The Quiet Shelf; a repeat on the same server finds it already there.
  const quietShelf = async () =>
    ((await (await page.request.get("/api/books")).json()) as { title: string; workId: string; hardcover?: { statusId: number | null; pending: boolean; listIds: number[] } }[])
      .find((b) => b.title === "The Quiet Shelf");
  const imported = (await quietShelf()) ? 0 : 1;
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(new RegExp(`Synced ${imported} new books`))).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main", exact: true })
    .getByRole("button", { name: "Library", exact: true })
    .click();
  // The Library half of guard 15 (spec #572) in its new form (#578): the shelf and list are in the sort-and-view
  // picker, each its own list inside it, and each filter in use is a chip under the heading that clears it.
  await inSortPicker(page, async (picker) => {
    await picker.getByRole("button", { name: "List: All lists", exact: true }).click();
    await picker.getByRole("radiogroup", { name: "List", exact: true }).getByRole("radio", { name: /^Weekend escapes · \d+$/ }).click();
    await expect(picker.getByRole("button", { name: "List: Weekend escapes", exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "Shelf: All shelves", exact: true }).click();
    await expect(picker.getByRole("radiogroup", { name: "Shelf", exact: true }).getByRole("radio")).toHaveText(["All shelves", "Want to read", "Currently reading", "Read", "Paused", "Did not finish"]);
    await picker.getByRole("radio", { name: "Want to read", exact: true }).click();
    await expect(picker.getByRole("button", { name: "Shelf: Want to read", exact: true })).toBeVisible();
  });
  await expect(page.getByRole("button", { name: "Clear the Hardcover shelf: Want to read", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear the Hardcover list: Weekend escapes", exact: true })).toBeVisible();
  // The strip of old is gone: no account line, no Sync now in the Library.
  await expect(page.getByRole("button", { name: "Sync now", exact: true })).toHaveCount(0);
  // One tile (#577): the Hardcover book with nothing yet has no marks on its cover.
  await expect(page.locator(".library-tile")).toHaveCount(1);
  await expect(page.locator(".library-tile .library-marks")).toHaveCount(0);
  await page
    .getByRole("button", { name: "About The Quiet Shelf", exact: true })
    .click();
  // The Book page (#532): Get for its audiobook, the main action; This device shows for every book in the library,
  // with nothing to save yet (#550).
  await expect(
    page.getByRole("button", { name: "Get an audiobook", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Keep on this device", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  // The book's Hardcover is one row with the shelf; it opens the Hardcover page (#529).
  await page
    .getByRole("region", { name: "Book", exact: true })
    .getByRole("button", { name: "Hardcover Want to read", exact: true })
    .click();
  await expect(page).toHaveURL(/#book\/[^/]+\/hardcover$/);
  await expect(page.getByRole("link", { name: "Open on Hardcover", exact: true })).toHaveAttribute("href", "https://hardcover.app/books/the-quiet-shelf");
  // No recording: nothing to play from Hardcover's place, and no edition of a recording to choose.
  await expect(page.getByRole("button", { name: "Use Hardcover position", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Hardcover edition/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Shelf Want to read", exact: true }).click();
  await page.getByRole("dialog", { name: "Shelf" }).getByRole("radio", { name: "Currently reading", exact: true }).click();
  await expect(page.getByRole("button", { name: "Shelf Currently reading", exact: true })).toBeVisible();
  await expect(page.getByText(/^(Saved · waiting to sync|Last synced .+)$/)).toBeVisible();
  await page.getByRole("switch", { name: "Weekend escapes", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Weekend escapes", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Book removed from this Hardcover list.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await expect(page).toHaveURL(/#book\/[^/]+$/);
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  await page.getByRole("button", { name: "Clear the Hardcover shelf: Want to read", exact: true }).click();
  await page.getByRole("button", { name: "Clear the Hardcover list: Weekend escapes", exact: true }).click();
  await expect(page.locator(".library-hardcover-chip")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "About Alice’s Adventures in Wonderland",
      exact: true,
    })
    .click();
  await page
    .getByRole("region", { name: "Book", exact: true })
    .getByRole("button", { name: "Hardcover Currently reading", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Shelf Currently reading", exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Use Hardcover position", exact: true })
    .click();
  await expect(page.locator(".player-dock").getByRole("button", {name:"Pause",exact:true})).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Hardcover edition: Automatic", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Hardcover edition" })
    .getByRole("radio", { name: "Kara Shallenberg · 5 h 58 min", exact: true })
    .click();
  await expect(page.getByText("Hardcover edition saved.", { exact: true })).toBeVisible();
  await page
    .locator(".player-dock")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect(page).toHaveURL(/#library$/);
  // Put The Quiet Shelf back on Want to read and in Weekend escapes, here and in the Hardcover fixture, so the
  // next run on this server finds the shelf and list it filters by as this one did.
  const quiet = (await quietShelf())!;
  expect((await page.request.patch("/api/hardcover/shelf", { data: { workId: quiet.workId, statusId: 1 } })).ok()).toBe(true);
  expect((await page.request.patch("/api/hardcover/lists/8803", { data: { workId: quiet.workId, included: true } })).ok()).toBe(true);
  // Sync now is on Settings' form, not in the Library (#578).
  await page.goto("/#settings/connections");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect
    .poll(async () => {
      const books = await (await page.request.get("/api/books")).json();
      return books.find((b: { id: string }) => b.id === "alice").hardcover
        .progressPending;
    })
    .toBe(false);
  await expect
    .poll(async () => {
      const hardcover = (await quietShelf())!.hardcover!;
      return { statusId: hardcover.statusId, pending: hardcover.pending, inList: hardcover.listIds.includes(8803) };
    })
    .toEqual({ statusId: 1, pending: false, inList: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  expect(errors).toEqual([]);
});
test("r6#4: a regular user is not offered to create or change the shared Hardcover match", async ({
  page,
}) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: {
        required: true,
        authenticated: true,
        user: { id: 1, username: "reader", role: "user" },
      },
    }),
  );
  await page.route("**/api/hardcover", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, configured: true, mode: "import" } });
  });
  await page.route("**/api/books", async (route) => {
    const books = await (await route.fetch()).json();
    await route.fulfill({
      json: books.map((b: { id: string }) =>
        b.id === "alice" || b.id === "frankenstein"
          ? {
              ...b,
              inLibrary: true,
              hardcover:
                b.id === "alice"
                  ? { id: 101, slug: "alice", series: [], statusId: 2, pending: false, progressFraction: null, progressPending: false, syncError: null, listIds: [] }
                  : undefined,
            }
          : b,
      ),
    });
  });
  // The Hardcover page reads the library by work: the same Alice, matched, there.
  const aliceWork = (await (await page.request.get("/api/books")).json()).find((b: { id: string }) => b.id === "alice").workId;
  await page.route("**/api/library", async (route) => {
    const works = await (await route.fetch({ headers: { ...route.request().headers(), "if-none-match": "" } })).json();
    await route.fulfill({
      json: works.map((w: { workId: string }) =>
        w.workId === aliceWork
          ? { ...w, hardcover: { id: 101, slug: "alice", series: [], statusId: 2, pending: false, progressFraction: null, progressPending: false, syncError: null, listIds: [] } }
          : w,
      ),
    });
  });
  await page.goto("/#library");
  await page.getByRole("button", { name: "About Alice’s Adventures in Wonderland", exact: true }).click();
  await page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: "Hardcover Currently reading", exact: true }).click();
  await expect(page.getByRole("button", { name: "Shelf Currently reading", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Change match/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to the book", exact: true }).click();
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await page.getByRole("button", { name: "About Frankenstein", exact: true }).click();
  await page.getByRole("region", { name: "Book", exact: true }).getByRole("button", { name: "Hardcover Not matched", exact: true }).click();
  await expect(page.getByText("Not matched on Hardcover. The administrator can match it.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Match/ })).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
