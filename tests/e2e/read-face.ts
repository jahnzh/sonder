// The reader on its own is gone (#613 part 2): a spec that opened `#reader/<ebook id>` opens Now playing's Read face
// of that ebook's book (#593) at `#read/<workId>`, with that edition chosen on this device. `#reader/<ebook id>`
// itself is an old name, tried in navigation.spec.ts.
import { expect, type Page } from "@playwright/test";

/** The work an ebook edition belongs to, as the reader's loader names it. */
export async function workOfEbook(page: Page, ebookId: string): Promise<string> {
  const response = await page.request.get(`/api/reader/${encodeURIComponent(ebookId)}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { workId: string }).workId;
}

/** The address of the Read face that shows this ebook edition. */
export async function readAddressOf(page: Page, ebookId: string): Promise<string> {
  return `#read/${encodeURIComponent(await workOfEbook(page, ebookId))}`;
}

/**
 * Opens the Read face of the ebook's book with that edition, as `#reader/<ebook id>` did. `how` "goto" loads the page
 * there; "hash" moves the open app there, as a link followed inside it.
 */
export async function gotoRead(page: Page, ebookId: string, how: "goto" | "hash" = "goto"): Promise<string> {
  const address = await readAddressOf(page, ebookId);
  if (how === "goto") {
    // The edition the Read face opens: this device's choice (no shared default is set by the specs that use this),
    // written on the app's origin before the app loads.
    if (!page.url().startsWith("http")) await page.goto("/api/health");
    await chooseEdition(page, address, ebookId);
    await page.goto(`/${address}`);
  } else {
    await chooseEdition(page, address, ebookId);
    await page.evaluate((target) => { location.hash = target; }, address);
  }
  return address;
}

async function chooseEdition(page: Page, address: string, ebookId: string) {
  const workId = decodeURIComponent(address.slice("#read/".length));
  // This device's choice of edition (ebook-choice.ts, deviceEbookChoiceKey); the suite's server has one user, whose
  // keys carry no prefix (userStorageKey).
  await page.evaluate(([workId, ebookId]) => localStorage.setItem(`reader-ebook:${workId}`, ebookId), [workId, ebookId] as const);
}
