// The Segmented control's keys (src/parts/Segmented.tsx), apart from React so they can be tested on their own. It
// is a radio group: the arrows move to the previous or next segment and choose it, wrapping at the ends; Home and
// End choose the first and the last. Disabled segments are passed over.

/** The index a key moves to from `current`, or null for a key the control does not handle. */
export function segmentForKey(key: string, current: number, enabled: readonly boolean[]): number | null {
  const count = enabled.length;
  if (!enabled.some(Boolean)) return null;
  const walk = (from: number, by: 1 | -1) => {
    let index = from;
    for (let i = 0; i < count; i++) {
      index = (index + by + count) % count;
      if (enabled[index]) return index;
    }
    return from;
  };
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return walk(current, 1);
    case "ArrowLeft":
    case "ArrowUp":
      return walk(current, -1);
    case "Home":
      return walk(count - 1, 1);
    case "End":
      return walk(0, -1);
    default:
      return null;
  }
}
