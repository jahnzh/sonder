#!/usr/bin/env node
// PreToolUse hook for Bash: refuse a MyAnonamouse address outside the API list (MAM rule 1.7).
// MAM allows automated access only to the functions its API Documentation lists, with the member's mam_id: no page
// fetches, no scraping, no login. Sonder's own calls are `MAM_ENDPOINTS` in server/sources/myanonamouse.ts;
// tests/block-mam-unlisted.test.mjs fails when one of those is not allowed here.
// Reads the hook JSON on stdin; exit 2 blocks the call and shows the message to the agent.
import { readFileSync } from "node:fs";

/** The paths a command may name on myanonamouse.net: MAM_ENDPOINTS, Load User Data, and the API documentation. */
export const ALLOWED_PATHS = [
  "/tor/js/loadSearchJSONbasic.php",
  "/tor/download.php",
  "/json/dynamicSeedbox.php",
  "/json/jsonIp.php",
  "/jsonLoad.php",
];
const ALLOWED_PREFIXES = ["/tor/download.php/", "/api/"];

// A host on myanonamouse.net (any subdomain), with an optional scheme before it and the path after it. The path ends at
// whitespace, a quote, a query or a shell character.
const MAM_ADDRESS = /(\b[a-z][a-z0-9+.-]*:\/\/)?((?:[a-z0-9-]+\.)*myanonamouse\.net)(?::\d+)?(\/[^\s'"`\\?#;&|()<>]*)?/gi;

function allowedPath(path) {
  if (path.split("/").includes("..") || /%2e|%2f/i.test(path)) return false;
  return ALLOWED_PATHS.includes(path) || ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** The MAM addresses in a command that are outside the allow-list. A host named with no scheme and no path is text. */
export function unlistedMamAddresses(command) {
  if (typeof command !== "string") return [];
  const found = [];
  for (const match of command.matchAll(MAM_ADDRESS)) {
    const [whole, scheme, , path] = match;
    // A mention of the site with no address (grep myanonamouse.net, a commit message) is not a call.
    if (!scheme && !path) continue;
    if (!allowedPath(path || "/")) found.push(whole);
  }
  return found;
}

export function blocksMamUnlisted(command) {
  return unlistedMamAddresses(command).length > 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let command;
  try {
    command = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command;
  } catch {
    process.exit(0);
  }
  const unlisted = unlistedMamAddresses(command);
  if (unlisted.length > 0) {
    console.error(
      `MAM rule 1.7: only the functions of MAM's API list may be called, with mam_id; no page fetches, scraping or login. ` +
        `Not on the list: ${unlisted.join(", ")}. Allowed paths on myanonamouse.net: ${ALLOWED_PATHS.join(", ")}, ` +
        `/tor/download.php/<hash>, and the API documentation under /api/ (server/sources/myanonamouse.ts MAM_ENDPOINTS).`,
    );
    process.exit(2);
  }
}
