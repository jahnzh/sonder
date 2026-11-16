/** The app's one size format: 1.4 GB, 414.0 MB, 12 KB. Kept apart from `lib.ts` (which needs a browser) so pure modules can use it. */
export function bytes(n: number) {
  return n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${Math.round(n / 1e3)} KB`;
}
