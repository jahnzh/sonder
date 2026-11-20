// The hidden switch of the reader plan (#799, step 3): which reading view this device opens. It is not shown anywhere
// in the interface. An address parameter sets it and it is remembered on the device:
//   https://<the app>/?reader-view=prepared   the new view, which shows the server's prepared text (ADR 0025)
//   https://<the app>/?reader-view=epub       back to today's reader (epub.js)
// Without it the reader is today's; step 7 makes the new view the default and removes this module.
export type ReaderViewChoice = "prepared" | "epub";
export const READER_VIEW_PARAMETER = "reader-view";
export const READER_VIEW_KEY = "sonder-reader-view";

/** What an address's query asks for; null when it does not name a view. */
export function readerViewFromSearch(search: string): ReaderViewChoice | null {
  const value = new URLSearchParams(search).get(READER_VIEW_PARAMETER);
  return value === "prepared" || value === "epub" ? value : null;
}

/** The address without the switch's parameter, everything else as it was. */
export function withoutReaderView(address: { pathname: string; search: string; hash: string }): string {
  const query = new URLSearchParams(address.search);
  query.delete(READER_VIEW_PARAMETER);
  const rest = query.toString();
  return `${address.pathname}${rest ? `?${rest}` : ""}${address.hash}`;
}

/** Read once as the app loads: a choice in the address is remembered and leaves the address. */
export function rememberReaderView() {
  const choice = readerViewFromSearch(location.search);
  if (!choice) return;
  try {
    if (choice === "prepared") localStorage.setItem(READER_VIEW_KEY, choice);
    else localStorage.removeItem(READER_VIEW_KEY);
  } catch {
    // Storage refused (a private window): the reader stays today's.
  }
  history.replaceState(history.state, "", withoutReaderView(location));
}

/** Whether this device opens the new view. */
export function preparedView(): boolean {
  try {
    return localStorage.getItem(READER_VIEW_KEY) === "prepared";
  } catch {
    return false;
  }
}
