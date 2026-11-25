// Two pages side by side on a desktop (#762): in Page mode, when the text area beside the contents and between the
// page arrows has room for two pages of the text's measure, the reader's host spans both and the view of prepared text
// lays out a spread (`src/prepared-view.ts`); narrower than that, one page (the 620 host of #595). Scroll mode is one
// column. No React: the reader measures the text area and asks here how wide the host is.

/** The gap between the two pages of a spread (and half of it outside each), in px. */
export const SPREAD_GAP = 48;
/** A host narrower than this never shows a spread (the minimum epub.js had, kept so the layout stays as it was). */
export const SPREAD_MIN_HOST = 800;
/** The share of the measure each page of two keeps at the least: below it the lines get too short, one page instead. */
export const SPREAD_MEASURE_SHARE = 0.6;

/** The reader's text settings the measure follows (`appearance.reader`). */
export interface SpreadText {
  /** The font size setting: the text is drawn at one px more on a desktop (`clamp(…, 4.6vw, size + 1)`). */
  size: number;
  /** The margin setting; 20 is the default, drawn as `clamp(20px, 6vw, 32px)`. */
  margin: number;
  /** The width setting; 720 is the default, drawn as a measure of 34em. */
  width: number;
}

/** The text's measure in px for a host of `host` px: the body's max-width (34em of the font, or the chosen width). */
export function textMeasure(text: SpreadText, host: number) {
  const font = Math.min(text.size + 1, Math.max(Math.max(14, text.size - 2), 0.046 * host));
  return text.width === 720 ? 34 * font : text.width;
}

/** The body's padding on each side of a page, in px, as the reader's theme draws it. */
export function textPadding(text: SpreadText, host: number) {
  return text.margin === 20 ? Math.min(32, Math.max(20, 0.06 * host)) : text.margin;
}

/**
 * The width of the reader's host in a spread, or null for one page. `available` is the width of the text area between
 * the page arrows. Each page of the spread is half the host less the gap (one column); it holds the body's
 * padding and a line of at least `SPREAD_MEASURE_SHARE` of the measure, and never more than the whole measure: the
 * host spans two such pages, up to the area's width. A larger font or a wider measure needs a wider area.
 */
export function spreadHostWidth(available: number, text: SpreadText, mode: "paginated" | "scroll") {
  if (mode !== "paginated" || !(available > 0)) return null;
  const page = (line: number, host: number) => 2 * (line + 2 * textPadding(text, host) + SPREAD_GAP);
  // The font and the padding follow the host's width; at a spread's width both are at their desktop values.
  const least = Math.max(SPREAD_MIN_HOST, page(SPREAD_MEASURE_SHARE * textMeasure(text, available), available));
  if (available < least) return null;
  return Math.floor(Math.min(available, Math.max(least, page(textMeasure(text, available), available))));
}
