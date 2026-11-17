// The book's Hardcover row (#529, spec #526 "Further down"; board BookMore.dc.html): "Hardcover" with the shelf,
// "Not on a shelf" or "Not matched", shown only when this user has connected Hardcover. It opens the Hardcover page.
// Today it stands in the book dialog; the Book page (#532) takes it over.
import type { Book } from "../types";
import { useHardcover } from "../components/Hardcover";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { hardcoverRowValue } from "../hardcover-page-model";

export function HardcoverRow({ match, onOpen }: { match: Book["hardcover"] | null | undefined; onOpen: () => void }) {
  const { state } = useHardcover();
  const value = hardcoverRowValue(state, match);
  if (value === null) return null;
  return (
    <Group label="Hardcover">
      <Row label="Hardcover" value={value} opens onClick={onOpen} />
    </Group>
  );
}
