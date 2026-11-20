// The place whose page the app shows (#713). A saved series shown beside the Library's list on a desktop is the
// Library's: the place shown before it (Discover, Activity, Settings) is not rendered under the Library and the series.
import type { Place } from "./routes";

export function placeShown<P extends Place>(under: P, seriesBeside: boolean): P | "library" {
  return seriesBeside ? "library" : under;
}
