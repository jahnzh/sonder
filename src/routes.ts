// Addresses (ADR 0020, spec #480 "Addresses and the page stack"). The one module that reads an address,
// writes one and names a page's parent. Pure: no `window`, no React. The history wiring is in navigation.ts.

/** One of the top-level areas. Activity took the Downloads slot (#516); `#downloads` is an old name for it (`OLD_NAMES`). */
export type Place = "library" | "discover" | "activity" | "settings";
export type BookPage = "audiobook" | "ebook" | "sync" | "chapters" | "bookmarks" | "search" | "match" | "edit";
export type ActivityPart = "now" | "device" | "server";
/**
 * The pages of Settings (spec #572, "Settings"): `#settings/<page>`. Keyboard shortcuts (#614) is not a row of the
 * list: it opens from Playback's row and Playback is its parent.
 */
export type SettingsPage = "account" | "appearance" | "playback" | "connections" | "users" | "library" | "app" | "keyboard";
export const SETTINGS_PAGES: readonly SettingsPage[] = ["account", "appearance", "playback", "connections", "users", "library", "app", "keyboard"];
/** The Settings pages only the administrator has (Connections since Hardcover went, #721 part d). */
export const ADMIN_SETTINGS_PAGES: readonly SettingsPage[] = ["connections", "users", "library"];
export function isSettingsPage(page: string): page is SettingsPage {
  return (SETTINGS_PAGES as readonly string[]).includes(page);
}

export type Route =
  | { name: "library" }
  | { name: "discover" }
  /** The Get sheet without a book (#575, spec #572 "Addresses"): a recording search for the words, over Discover. */
  | { name: "discover-get"; query: string }
  | { name: "activity"; part: ActivityPart }
  | { name: "worker"; worker: string }
  | { name: "settings" }
  | { name: "settings-page"; page: string }
  | { name: "book"; workId: string }
  | { name: "book-page"; workId: string; page: BookPage }
  /** The Details of a book's Reading sync (#540): engine, GPU use, processing and stage times. */
  | { name: "sync-details"; workId: string }
  | { name: "get"; workId: string; kind: "audiobook" | "ebook" }
  /** Paste a magnet link (#606): a sheet over the Get audiobook sheet. */
  | { name: "get-magnet"; workId: string }
  | { name: "series"; id: string }
  | { name: "series-add"; id: string }
  /** A book of a saved series (#898): a sheet over the Series page with what its search found and chose. */
  | { name: "series-book"; id: string; bookId: string }
  | { name: "listen"; workId: string }
  | { name: "read"; workId: string }
  /** The parts gallery (#486): an address of its own that no navigation links to, for the browser tests and builders. */
  | { name: "gallery" }
  /** The gallery's one child page, so the Page header's back button can be tried. */
  | { name: "gallery-child" }
  /** The gallery's own sheet (#492), over the gallery: no real sheet exists before Get. */
  | { name: "gallery-sheet" }
  /** An address that names nothing; it shows the first page of the place it points into. */
  | { name: "unknown"; place: Place };

const BOOK_PAGES: readonly BookPage[] = ["audiobook", "ebook", "sync", "chapters", "bookmarks", "search", "match", "edit"];

function decode(part: string): string | null {
  try {
    const value = decodeURIComponent(part);
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Old names (#455, spec #608 "Old names"): addresses from before the redesign, each with the page that took its
 * place. They keep working for good: reading one returns the route of that page, marked as a redirect, so the
 * history entry is replaced (ADR 0020). No route, place or page exists for an old name itself.
 */
export const OLD_NAMES: readonly {
  /** The first part of the old address, after its `#`. */
  head: string;
  /** The address of the page that took its place, as the README and the glossary name it. */
  becomes: string;
  /** The route it reads as, from the parts after the head; null when those parts name nothing in `place`. */
  read: (rest: readonly string[]) => Route | null;
  /**
   * The ebook edition the old address names, when only the server knows its work: the route above is then the
   * link's place (`place`'s first page) until `editionRoute` makes the Read face of the work from the answer.
   */
  edition?: (rest: readonly string[]) => string | null;
  place: Place;
}[] = [
  // The Downloads page, which Activity replaced (#516): it opens Now.
  { head: "downloads", becomes: "#activity", read: (rest) => (rest.length ? null : { name: "activity", part: "now" }), place: "activity" },
  // The reader on its own (#613 part 2): Now playing's Read face of the ebook's book, with that edition (#596).
  // The work is the server's to find; until it answers, and when the ebook is gone, the Library is in the link's place.
  { head: "reader", becomes: "#read/<workId>", read: () => null, edition: readerEdition, place: "library" },
];

/** The ebook id of `#reader/<ebook id>`: today's reader read everything after "reader/" as the id, slashes too. */
function readerEdition(rest: readonly string[]): string | null {
  return rest.length ? decode(rest.join("/")) : null;
}

/**
 * An address as read: its route, whether it was an old name that the history entry is to be replaced by, and the
 * ebook edition an old reader link names, whose work the server is asked for (`editionRoute`).
 */
export type ReadAddress = { route: Route; redirect: boolean; edition?: string };

/** Reads an address and says whether it was an old name (`OLD_NAMES`). Never throws. */
export function readLink(hash: string): ReadAddress {
  const [head, ...rest] = (hash.startsWith("#") ? hash.slice(1) : hash).split("/");
  const old = OLD_NAMES.find((entry) => entry.head === head);
  const edition = old?.edition?.(rest) ?? null;
  return { route: readAddress(hash), redirect: !!old, ...(edition ? { edition } : {}) };
}

/**
 * The route an old reader link becomes once the server named the edition's work: the Read face of that work. Null
 * when the server knows no work for it (the ebook is gone): the link's place stays.
 */
export function editionRoute(answer: { workId?: string | null } | null): Extract<Route, { name: "read" }> | null {
  return answer?.workId ? { name: "read", workId: answer.workId } : null;
}

/** Reads an address (`location.hash`, with or without its `#`). Never throws. An old name reads as its new route. */
export function readAddress(hash: string): Route {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  // The installed app opens "/", with no address: it starts on the Library.
  if (!text) return { name: "library" };
  const [head, ...rest] = text.split("/");
  const nothing = (place: Place): Route => ({ name: "unknown", place });
  const old = OLD_NAMES.find((entry) => entry.head === head);
  if (old) return old.read(rest) ?? nothing(old.place);
  switch (head) {
    case "discover": {
      const query = rest.length === 2 && rest[0] === "get" ? decode(rest[1]) : null;
      if (query) return { name: "discover-get", query };
      return rest.length ? nothing(head) : { name: head };
    }
    case "library":
      return rest.length ? nothing(head) : { name: head };
    case "settings": {
      if (!rest.length) return { name: "settings" };
      const page = rest.length === 1 ? decode(rest[0]) : null;
      return page ? { name: "settings-page", page } : nothing("settings");
    }
    case "activity": {
      if (!rest.length) return { name: "activity", part: "now" };
      if (rest.length === 1 && rest[0] === "device") return { name: "activity", part: "device" };
      if (rest[0] === "server") {
        if (rest.length === 1) return { name: "activity", part: "server" };
        const worker = rest.length === 2 ? decode(rest[1]) : null;
        if (worker) return { name: "worker", worker };
      }
      return nothing("activity");
    }
    case "book": {
      const workId = rest[0] !== undefined ? decode(rest[0]) : null;
      if (!workId) return nothing("library");
      if (rest.length === 1) return { name: "book", workId };
      if (rest.length === 2 && (BOOK_PAGES as readonly string[]).includes(rest[1]))
        return { name: "book-page", workId, page: rest[1] as BookPage };
      // The Hardcover page an older build linked to (#529) is gone (#721 part d): its address opens the match page
      // that took the place of its Change match.
      if (rest.length === 2 && rest[1] === "hardcover") return { name: "book-page", workId, page: "match" };
      if (rest.length === 3 && rest[1] === "sync" && rest[2] === "details") return { name: "sync-details", workId };
      if (rest.length === 3 && rest[1] === "get" && (rest[2] === "audiobook" || rest[2] === "ebook"))
        return { name: "get", workId, kind: rest[2] };
      // The magnet sheet over Get audiobook (#606); any other fourth part names nothing.
      if (rest.length === 4 && rest[1] === "get" && rest[2] === "audiobook" && rest[3] === "magnet")
        return { name: "get-magnet", workId };
      return nothing("library");
    }
    case "series": {
      const id = rest[0] !== undefined ? decode(rest[0]) : null;
      if (!id) return nothing("library");
      if (rest.length === 1) return { name: "series", id };
      if (rest.length === 2 && rest[1] === "add") return { name: "series-add", id };
      const bookId = rest.length === 3 && rest[1] === "book" ? decode(rest[2]) : null;
      if (bookId) return { name: "series-book", id, bookId };
      return nothing("library");
    }
    case "listen":
    case "read": {
      const workId = rest.length === 1 ? decode(rest[0]) : null;
      return workId ? { name: head, workId } : nothing("library");
    }
    case "gallery":
      if (!rest.length) return { name: "gallery" };
      if (rest.length === 1 && rest[0] === "child") return { name: "gallery-child" };
      return rest.length === 1 && rest[0] === "sheet" ? { name: "gallery-sheet" } : nothing("library");
    default:
      return nothing("library");
  }
}

const part = encodeURIComponent;

/** Writes the address of a route, with its `#`. An address that names nothing writes its place's first page. */
export function writeAddress(route: Route): string {
  switch (route.name) {
    case "library":
    case "discover":
    case "settings":
      return `#${route.name}`;
    case "activity":
      return route.part === "now" ? "#activity" : `#activity/${route.part}`;
    case "worker":
      return `#activity/server/${part(route.worker)}`;
    case "discover-get":
      return `#discover/get/${part(route.query)}`;
    case "settings-page":
      return `#settings/${part(route.page)}`;
    case "book":
      return `#book/${part(route.workId)}`;
    case "book-page":
      return `#book/${part(route.workId)}/${route.page}`;
    case "get":
      return `#book/${part(route.workId)}/get/${route.kind}`;
    case "get-magnet":
      return `#book/${part(route.workId)}/get/audiobook/magnet`;
    case "sync-details":
      return `#book/${part(route.workId)}/sync/details`;
    case "series":
      return `#series/${part(route.id)}`;
    case "series-add":
      return `#series/${part(route.id)}/add`;
    case "series-book":
      return `#series/${part(route.id)}/book/${part(route.bookId)}`;
    case "listen":
    case "read":
      return `#${route.name}/${part(route.workId)}`;
    case "gallery":
      return "#gallery";
    case "gallery-child":
      return "#gallery/child";
    case "gallery-sheet":
      return "#gallery/sheet";
    case "unknown":
      return writeAddress(firstPage(route.place));
  }
}

/** The place a route belongs to: the tab that shows as current, and where an address that names nothing lands. */
export function placeOf(route: Route): Place {
  switch (route.name) {
    case "discover":
    case "settings":
      return route.name;
    case "discover-get":
      return "discover";
    case "settings-page":
      return "settings";
    case "activity":
    case "worker":
      return "activity";
    case "unknown":
      return route.place;
    default:
      return "library";
  }
}

export function firstPage(place: Place): Route {
  return place === "activity" ? { name: "activity", part: "now" } : { name: place };
}

export function isFirstPage(route: Route): boolean {
  return sameRoute(route, firstPage(placeOf(route)));
}

/** Where a page's own back button goes when no entry of the app lies behind it; null for a place's own pages. */
export function parentOf(route: Route): Route | null {
  switch (route.name) {
    case "book-page":
    case "get":
    case "listen":
    case "read":
      return { name: "book", workId: route.workId };
    case "book":
    case "series":
      return { name: "library" };
    case "series-add":
    case "series-book":
      return { name: "series", id: route.id };
    // The magnet sheet belongs to the Get audiobook sheet it covers (#606).
    case "get-magnet":
      return { name: "get", workId: route.workId, kind: "audiobook" };
    // Details belongs to the book's Reading sync page (#540).
    case "sync-details":
      return { name: "book-page", workId: route.workId, page: "sync" };
    case "worker":
      return { name: "activity", part: "server" };
    // Keyboard shortcuts belongs to Playback, whose row opens it (#614).
    case "settings-page":
      return route.page === "keyboard" ? { name: "settings-page", page: "playback" } : { name: "settings" };
    case "discover-get":
      return { name: "discover" };
    case "gallery-child":
    case "gallery-sheet":
      return { name: "gallery" };
    default:
      return null;
  }
}

/** A sheet or Now playing (with its Read face): shown over a page rather than in place of it. */
export function coversPage(route: Route): boolean {
  return ["get", "get-magnet", "discover-get", "series-add", "series-book", "listen", "read", "gallery-sheet"].includes(route.name);
}

/**
 * Whether Back may return this page to where it was scrolled: its list is shown again as it was left. Every page's
 * is; Discover's results are kept in its history entry since #575, so its offset points into the same list.
 */
export function keepsScroll(route: Route): boolean {
  return !!route;
}

export function sameRoute(a: Route, b: Route): boolean {
  return writeAddress(a) === writeAddress(b);
}

/**
 * Whether moving from one route to another adds a history entry or replaces the current one.
 * Activity's parts replace each other, as do two workers' pages and Listen and Read of one work; everything else
 * that moves adds one.
 * A redirect from an old name or a bad address also replaces, but that happens when an address is read.
 */
export function step(from: Route, to: Route): "push" | "replace" | "none" {
  if (sameRoute(from, to)) return "none";
  if (from.name === "activity" && to.name === "activity") return "replace";
  // Choosing another worker beside the Server list (a desktop) replaces the one shown (#520).
  if (from.name === "worker" && to.name === "worker") return "replace";
  if ((from.name === "listen" || from.name === "read") && (to.name === "listen" || to.name === "read") && from.workId === to.workId)
    return "replace";
  // Chapters and Bookmarks are one page with a segmented control: the segment replaces the entry (#590).
  if (
    from.name === "book-page" && to.name === "book-page" && from.workId === to.workId &&
    (from.page === "chapters" || from.page === "bookmarks") && (to.page === "chapters" || to.page === "bookmarks")
  )
    return "replace";
  return "push";
}

/** Pages with a screen in this build. Every other address behaves like one that names nothing until its slice lands. */
function built(route: Route): boolean {
  // The Audiobook page (#530) and its Ebook page (#531); the book's other pages come with their own tickets.
  if (route.name === "book-page" && (route.page === "audiobook" || route.page === "ebook")) return true;
  // A book's catalogue match page (#721), in place of the Hardcover page (#721 part d).
  if (route.name === "book-page" && route.page === "match") return true;
  // A book's Edit page (#719 part a), the administrator's.
  if (route.name === "book-page" && route.page === "edit") return true;
  // The reader's pages: Chapters, Bookmarks and Search (#590).
  if (route.name === "book-page" && (route.page === "chapters" || route.page === "bookmarks" || route.page === "search")) return true;
  // The Reading sync page and its Details (#540).
  if ((route.name === "book-page" && route.page === "sync") || route.name === "sync-details") return true;
  switch (route.name) {
    // The Book page (#532).
    case "book":
    // The Series page of a saved series (#562).
    case "series":
    // Its Add sheet (#563) and a book's search sheet (#898).
    case "series-add":
    case "series-book":
    case "library":
    case "discover":
    // The Get sheet without a book (#575, #576): the recording chosen makes the book.
    case "discover-get":
    case "settings":
    case "gallery":
    case "gallery-child":
    case "gallery-sheet":
    // Now playing, its Listen and Read faces (#593).
    case "listen":
    case "read":
      return true;
    case "settings-page":
      return isSettingsPage(route.page);
    case "activity":
      return route.part === "now" || route.part === "device" || route.part === "server";
    // The worker's page (#520). A worker the server does not report shows Server, once the page has read the server.
    case "worker":
      return true;
    // The Get audiobook sheet (#601) and the Get ebook sheet (#604).
    case "get":
      return route.kind === "audiobook" || route.kind === "ebook";
    // Its magnet sheet (#606).
    case "get-magnet":
      return true;
    default:
      return false;
  }
}

/** Activity's Server part and its workers are the administrator's; Now and This device are everyone's. So are Users and Library and storage in Settings. */
function allowed(route: Route, admin: boolean): boolean {
  if (admin) return true;
  if (route.name === "settings-page") return !(ADMIN_SETTINGS_PAGES as readonly string[]).includes(route.page);
  // Getting files is the administrator's (#601, #604), with or without a book (#575).
  if (route.name === "get" || route.name === "get-magnet" || route.name === "discover-get") return false;
  return !(route.name === "worker" || (route.name === "activity" && route.part === "server"));
}

/**
 * What an address shows for this user: the route itself, or the first page of its place when the address names
 * nothing, names a page not built yet, or names an administrator's page for someone else. The Library as last resort.
 */
export function resolve(route: Route, { admin }: { admin: boolean }): Route {
  if (route.name !== "unknown" && built(route) && allowed(route, admin)) return route;
  // Someone who is not the administrator gets the book's own page at a Get sheet's address (#601).
  if ((route.name === "get" || route.name === "get-magnet") && built(route)) return { name: "book", workId: route.workId };
  const first = firstPage(placeOf(route));
  // Every place's first page is built and everyone's.
  return first;
}
