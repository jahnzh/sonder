// @projects firefox
// The series queue on the Series page (#898): the administrator saves The Lantern Keeper (704) with its audiobooks,
// sees the run line while the first book is searched and the others wait (each row with its place in line), then opens
// a book's search sheet: the release the queue chose with why and its page, the other releases it found, and chooses
// another one instead. The searches are tests/series-queue-browser-fixture.ts's; no torrent client is reached.
import { test, expect } from "./own-server";
import { connectAudiobookDb, saveSeriesOnPage, viewSeriesFromDiscover } from "./series-save";

test.use({ serviceWorkers: "block" });

test("the run line, a book's chosen release and the others found, and Choose this one instead", async ({ page }) => {
  await connectAudiobookDb(page);
  // The searches wait until the spec lets them go: one runs, the others wait.
  expect((await page.request.post("/api/__fixture/series-queue", { data: { hold: true } })).ok()).toBe(true);
  await viewSeriesFromDiscover(page, "Lantern", "The Lantern Keeper", "Iris Vale");
  await saveSeriesOnPage(page, { get: ["audiobooks"] });

  const region = page.getByRole("region", { name: "Series", exact: true });
  const run = region.getByRole("group", { name: "Series search", exact: true });
  await expect(run.getByRole("status")).toHaveText("Searching for book 1 · audiobook · 2 waiting");
  await expect(run.getByRole("button", { name: "Stop searching for this series", exact: true })).toBeVisible();
  const books = region.getByRole("list", { name: /^Books/ });
  await expect(books.getByRole("button", { name: /Keeper of Tides Waiting · 2nd in line$/ })).toBeVisible();
  await expect(books.getByRole("button", { name: /The Last Light Waiting · 3rd in line$/ })).toBeVisible();
  await expect(books.getByRole("button", { name: /The Lantern Keeper Searching for the audiobook$/ })).toBeVisible();

  // Let the searches go: the queue works through the three books (no wait between them under test) and the line goes.
  expect((await page.request.post("/api/__fixture/series-queue", { data: { hold: false } })).ok()).toBe(true);
  await expect(run).toHaveCount(0, { timeout: 20_000 });

  // The first book's row opens its search sheet over the page.
  await books.getByRole("button", { name: /The Lantern Keeper Not started$/ }).click();
  await expect(page).toHaveURL(/#series\/704\/book\/721$/);
  const sheet = page.getByRole("dialog", { name: "Series search" });
  await expect(sheet).toBeVisible();
  const chosen = sheet.getByRole("group", { name: "Chosen", exact: true });
  await expect(chosen).toContainText("The Lantern Keeper");
  await expect(chosen).toContainText("English · Kara Shallenberg · M4B · 420 MB");
  await expect(chosen).toContainText("Chosen by the queue · one book, not a set · TorBox has it");
  await expect(chosen.getByRole("link", { name: "On AudioBookBay" })).toHaveAttribute("href", "https://audiobookbay.test/abss/lantern-the-lantern-keeper-en/");

  // The other releases found, the French one among them; choosing it downloads it instead.
  const others = sheet.getByRole("radiogroup", { name: "Other recordings found · 2" });
  await expect(others.getByRole("radio")).toHaveCount(2);
  const choose = sheet.getByRole("button", { name: "Choose this one instead", exact: true });
  await expect(choose).toBeDisabled();
  await others.getByRole("radio", { name: /version française/ }).click();
  await expect(sheet.getByTestId("choose-line")).toHaveText("Downloads to your server first.");
  const sent = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/works/721/acquisition/choose"));
  await choose.click();
  expect((await sent).ok()).toBe(true);
  await expect(chosen).toContainText("The Lantern Keeper (version française)");
  await expect(chosen).toContainText("French · Claire Dubois · MP3 · 390 MB");
  await expect(chosen).toContainText("Chosen by you");
  await expect(sheet.getByRole("radiogroup", { name: "Other recordings found · 2" }).getByRole("radio", { name: /^The Lantern Keeper English/ })).toBeVisible();

  // Close goes back to the Series page.
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/#series\/704$/);
});
