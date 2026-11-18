// More › Reading sync in the reader (#543, spec #537 "Where the page is opened from"): one row with the reading
// sync's line, the Book page's line for the work's chosen pair, opening the Reading sync page `#book/<workId>/sync`.
// Without both files (no chosen recording or EPUB) the row only shows its line, as the Book page's row does.
import { isAdmin } from "../lib";
import { useWork } from "../library-works-store";
import { navigate } from "../navigation";
import { useDeviceEbookChoice } from "../ebook-device-copy";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { bookModel } from "../pages/book-model";

export function ReaderSyncRow({ workId }: { workId: string }) {
  const { work } = useWork(workId);
  const deviceChoice = useDeviceEbookChoice(workId);
  const sync = work ? bookModel(work, { admin: isAdmin(), deviceChoice }).sync : null;
  return (
    <Group label="Reading sync">
      {!sync || sync.opens ? (
        <Row label="Reading sync" value={sync?.line} opens onClick={() => navigate({ name: "book-page", workId, page: "sync" })} />
      ) : (
        <Row label="Reading sync" value={sync.line} />
      )}
    </Group>
  );
}
