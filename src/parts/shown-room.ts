// The part of the layout viewport the screen shows (src/parts/Sheet.tsx): a phone's keyboard narrows the visual
// viewport and leaves the layout viewport as it was, so a sheet sized to the layout viewport has its foot under the
// keyboard.

/**
 * The room the screen shows inside the layout viewport: how far a keyboard (or anything the browser draws over the
 * page) reaches up from the bottom, and how far the shown part is scrolled down from the top. Zero while zoomed in,
 * when the shown part is smaller for another reason.
 */
export function shownRoom(view: { height: number; offsetTop: number; scale: number }, layoutHeight: number) {
  if (Math.abs(view.scale - 1) > 0.01) return { top: 0, bottom: 0 };
  const top = Math.max(0, Math.round(view.offsetTop));
  return { top, bottom: Math.max(0, Math.round(layoutHeight - view.height - view.offsetTop)) };
}
