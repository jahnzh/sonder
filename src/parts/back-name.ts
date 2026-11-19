// What a Page header's back button is called: "Back to" and where it goes (boards: "Back to Library",
// "Back to Discover", "Back to the book"). Pure, for the unit tests.
import type { Route } from "../routes";

/** The name of the page a back button lands on, as the boards say it; a page with a name of its own passes it in. */
export function pageName(route: Route): string {
  switch (route.name) {
    case "library":
    case "unknown":
      return "Library";
    case "discover":
    case "discover-get":
      return "Discover";
    case "activity":
      return route.part === "device" ? "This device" : route.part === "server" ? "Server" : "Activity";
    case "worker":
      return "the worker";
    case "settings":
      return "Settings";
    case "settings-page":
      return "Settings";
    case "book-page":
      // Details goes back to Reading sync (#540); the book's other pages go back to the book.
      return route.page === "sync" ? "Reading sync" : "the book";
    case "sync-details":
      return "Reading sync";
    case "book":
    case "get":
    case "listen":
    case "read":
      return "the book";
    case "series":
    case "series-add":
      return "the series";
    case "get-magnet":
      return "Get audiobook";
    case "gallery":
      return "Gallery";
    case "gallery-child":
      return "Child page";
    case "gallery-sheet":
      return "the sheet";
  }
}

/** The back button's name. `named` gives a page its own name when the generic one is not enough. */
export function backName(target: Route, named?: (route: Route) => string | null | undefined): string {
  return `Back to ${named?.(target) ?? pageName(target)}`;
}
