// The link out of a Get sheet to the chosen candidate's own page (#889), what both sheets' rules share. Pure: no React,
// no window.

/** A link out of the sheet: the words it says and where it leads. */
export type SourceLink = { text: string; href: string };

/**
 * Whether an address is one a link may lead to: an `http:` or `https:` address with a host and no credentials in it
 * (`https://user:pass@host` would put them in the owner's history and the other site's logs).
 */
export function isWebAddress(url: string | null | undefined): url is string {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname && !parsed.username && !parsed.password;
}
