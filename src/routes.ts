// Addresses (ADR 0020, spec #480 "Addresses and the page stack"). The one module that reads an address,
// writes one and names a page's parent. Pure: no `window`, no React. The history wiring is in navigation.ts.

/** One of the top-level areas. `downloads` is its own place until Activity replaces the Downloads page. */
export type Place = "library" | "discover" | "downloads" | "activity" | "settings";
export type BookPage = "audiobook" | "ebook" | "sync" | "hardcover" | "chapters" | "bookmarks" | "search";
export type ActivityPart = "now" | "device" | "server";

export type Route =
  | { name: "library" }
  | { name: "discover" }
  /** Old name: the Downloads page, until Activity replaces it and `#downloads` opens Activity. */
  | { name: "downloads" }
  | { name: "activity"; part: ActivityPart }
  | { name: "worker"; worker: string }
  | { name: "settings" }
  | { name: "settings-page"; page: string }
  | { name: "book"; workId: string }
  | { name: "book-page"; workId: string; page: BookPage }
  | { name: "get"; workId: string; kind: "audiobook" | "ebook" }
  | { name: "series"; id: string }
  | { name: "series-add"; id: string }
  | { name: "listen"; workId: string }
  | { name: "read"; workId: string }
  /** Old name: the reader for one ebook edition, until it opens the Read face of that ebook's book. */
  | { name: "reader"; ebookId: string }
  /** The parts gallery (#486): an address of its own that no navigation links to, for the browser tests and builders. */
  | { name: "gallery" }
  /** The gallery's one child page, so the Page header's back button can be tried. */
  | { name: "gallery-child" }
  /** The gallery's own sheet (#492), over the gallery: no real sheet exists before Get. */
  | { name: "gallery-sheet" }
  /** An address that names nothing; it shows the first page of the place it points into. */
  | { name: "unknown"; place: Place };

const BOOK_PAGES: readonly BookPage[] = ["audiobook", "ebook", "sync", "hardcover", "chapters", "bookmarks", "search"];

function decode(part: string): string | null {
  try {
    const value = decodeURIComponent(part);
    return value ? value : null;
  } catch {
    return null;
  }
}

/** Reads an address (`location.hash`, with or without its `#`). Never throws. */
export function readAddress(hash: string): Route {
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  // The installed app opens "/", with no address: it starts on the Library.
  if (!text) return { name: "library" };
  const [head, ...rest] = text.split("/");
  const nothing = (place: Place): Route => ({ name: "unknown", place });
  switch (head) {
    case "library":
    case "discover":
    case "downloads":
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
      if (rest.length === 3 && rest[1] === "get" && (rest[2] === "audiobook" || rest[2] === "ebook"))
        return { name: "get", workId, kind: rest[2] };
      return nothing("library");
    }
    case "series": {
      const id = rest[0] !== undefined ? decode(rest[0]) : null;
      if (!id) return nothing("library");
      if (rest.length === 1) return { name: "series", id };
      if (rest.length === 2 && rest[1] === "add") return { name: "series-add", id };
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
    case "reader": {
      // Today's reader read everything after "reader/" as the id, so an id with a slash keeps working.
      const ebookId = rest.length ? decode(rest.join("/")) : null;
      return ebookId ? { name: "reader", ebookId } : nothing("library");
    }
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
    case "downloads":
    case "settings":
      return `#${route.name}`;
    case "activity":
      return route.part === "now" ? "#activity" : `#activity/${route.part}`;
    case "worker":
      return `#activity/server/${part(route.worker)}`;
    case "settings-page":
      return `#settings/${part(route.page)}`;
    case "book":
      return `#book/${part(route.workId)}`;
    case "book-page":
      return `#book/${part(route.workId)}/${route.page}`;
    case "get":
      return `#book/${part(route.workId)}/get/${route.kind}`;
    case "series":
      return `#series/${part(route.id)}`;
    case "series-add":
      return `#series/${part(route.id)}/add`;
    case "listen":
    case "read":
      return `#${route.name}/${part(route.workId)}`;
    case "reader":
      return `#reader/${part(route.ebookId)}`;
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
    case "downloads":
    case "settings":
      return route.name;
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
    case "reader":
      return { name: "library" };
    case "series-add":
      return { name: "series", id: route.id };
    case "worker":
      return { name: "activity", part: "server" };
    case "settings-page":
      return { name: "settings" };
    case "gallery-child":
    case "gallery-sheet":
      return { name: "gallery" };
    default:
      return null;
  }
}

/** A sheet, Now playing or the reader: shown over a page rather than in place of it. */
export function coversPage(route: Route): boolean {
  return ["get", "series-add", "listen", "read", "reader", "gallery-sheet"].includes(route.name);
}

/**
 * Whether Back may return this page to where it was scrolled: its list is shown again as it was left. Discover's
 * search results live in the page and are gone once it is left (they come back with the Discover slice), so an
 * old offset would point into another list: it starts at its top instead.
 */
export function keepsScroll(route: Route): boolean {
  return route.name !== "discover";
}

export function sameRoute(a: Route, b: Route): boolean {
  return writeAddress(a) === writeAddress(b);
}

/**
 * Whether moving from one route to another adds a history entry or replaces the current one.
 * Activity's parts replace each other, as do Listen and Read of one work; everything else that moves adds one.
 * A redirect from an old name or a bad address also replaces, but that happens when an address is read.
 */
export function step(from: Route, to: Route): "push" | "replace" | "none" {
  if (sameRoute(from, to)) return "none";
  if (from.name === "activity" && to.name === "activity") return "replace";
  if ((from.name === "listen" || from.name === "read") && (to.name === "listen" || to.name === "read") && from.workId === to.workId)
    return "replace";
  return "push";
}

/** Pages with a screen in this build. Every other address behaves like one that names nothing until its slice lands. */
function built(route: Route): boolean {
  switch (route.name) {
    case "library":
    case "discover":
    case "downloads":
    case "settings":
    case "reader":
    case "gallery":
    case "gallery-child":
    case "gallery-sheet":
      return true;
    case "activity":
      return route.part === "now";
    default:
      return false;
  }
}

/** Activity is the administrator's today, its Server part and workers for good. */
function allowed(route: Route, admin: boolean): boolean {
  return admin || placeOf(route) !== "activity";
}

/**
 * What an address shows for this user: the route itself, or the first page of its place when the address names
 * nothing, names a page not built yet, or names an administrator's page for someone else. The Library as last resort.
 */
export function resolve(route: Route, { admin }: { admin: boolean }): Route {
  if (route.name !== "unknown" && built(route) && allowed(route, admin)) return route;
  const first = firstPage(placeOf(route));
  // Every place's first page is built; only Activity's is the administrator's.
  if (allowed(first, admin)) return first;
  return { name: "library" };
}
