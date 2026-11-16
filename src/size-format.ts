/**
 * The app's one size format: 1.4 GB, 414 MB, 0.6 MB, 12 KB. One decimal below ten, none from ten up, and no
 * ".0", as the redesign's boards write sizes. Kept apart from `lib.ts` (which needs a browser) so pure modules can use it.
 */
function figure(value: number) {
  return value >= 9.95 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}
export function bytes(n: number) {
  return n >= 1e9 ? `${figure(n / 1e9)} GB` : n >= 1e6 ? `${figure(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`;
}
