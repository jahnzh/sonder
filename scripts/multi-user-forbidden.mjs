// Admin-only method/path pairs a regular user must receive 403 for.
// Shared by scripts/verify-multi-user.mjs (live) and tests/users.test.ts (unit).
// Keep side-effect free: importing this module must not launch a browser or hit production.

/** @type {ReadonlyArray<readonly [string, string, Record<string, unknown>?]>} */
export const FORBIDDEN = Object.freeze([
  ["PATCH", "/api/settings", { torbox: "x" }],
  ["POST", "/api/acquire", {}],
  ["POST", "/api/import", {}],
  ["POST", "/api/alignments", {}],
  ["GET", "/api/torrents/health"],
  ["GET", "/api/acquisitions"],
  ["GET", "/api/users"],
  ["GET", "/api/discover/ebooks?source=libgen&q=test"],
  // Percent-encoded variants of admin routes must be refused too (review r2#1).
  ["GET", "/api/%61cquisitions"],
  ["GET", "/api/torrents/he%61lth"],
  ["DELETE", "/api/recordings/qa-none/server%2Dcopy"],
  ["POST", "/api/%65books/import", {}],
  ["GET", "/api/discover/%61bb?q=test"],
]);
