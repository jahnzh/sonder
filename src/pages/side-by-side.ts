// The width from which a page that belongs to a list is shown beside it (the rail's, spec #572 "The shell"): the
// chosen Settings page beside the Settings list, a worker's page beside the Server list (#520).
import { useSyncExternalStore } from "react";

export const SIDE_BY_SIDE = "(min-width: 760px)";

export function useSideBySide(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = matchMedia(SIDE_BY_SIDE);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => matchMedia(SIDE_BY_SIDE).matches,
  );
}
