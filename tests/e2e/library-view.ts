// The Library's sort-and-view control (#578) for the browser specs: open its Picker, choose, close with Done.
import { expect, type Page } from "@playwright/test";

/** The control under the heading, "<sort> · <view>". */
export const sortAndView = (page: Page) => page.getByRole("button", { name: /^Sort and view: / });
/** The open picker. */
export const sortPicker = (page: Page) => page.getByRole("dialog", { name: "Sort and view", exact: true });

/** Opens the picker, applies `act` inside it and closes it with Done. */
export async function inSortPicker(page: Page, act: (picker: ReturnType<typeof sortPicker>) => Promise<void>) {
  await sortAndView(page).click();
  await expect(sortPicker(page)).toBeVisible();
  await act(sortPicker(page));
  await sortPicker(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(sortPicker(page)).toHaveCount(0);
}

/** Shows the Library as a grid or a list. */
export async function chooseView(page: Page, view: "Grid" | "List") {
  await inSortPicker(page, async (picker) => {
    await picker.getByRole("radiogroup", { name: "View", exact: true }).getByRole("radio", { name: view, exact: true }).click();
  });
}

/** A row of the list view (a Book row without a chevron), by its title. */
export const listRow = (page: Page, title: string) =>
  page.locator(".library-list .part-book-row-item").filter({ has: page.locator(".part-book-row-title", { hasText: new RegExp(`^${escaped(title)}$`) }) });
const escaped = (text: string) => text.replace(/[.*+?^$|()[\]{}\\]/g, "\\$&");
