// Where the Picker (Picker.tsx) stands: a pure module, so the unit tests read it without the part's stylesheet.
/** At this width and wider the picker opens under its button; narrower it rises from the bottom edge. */
export const PICKER_DESKTOP_WIDTH = 760;

/** Where the picker stands on a desktop: under the button, its right edge on the button's, inside the window. */
export function pickerPlace(
  button: { top: number; bottom: number; left: number; right: number },
  window: { width: number; height: number },
  width: number,
): { top: number; left: number; maxHeight: number } {
  const edge = 16;
  const left = Math.max(edge, Math.min(button.right - width, window.width - width - edge));
  const top = button.bottom + 8;
  return { top, left, maxHeight: Math.max(160, window.height - top - edge) };
}
