import { AcquisitionQueue } from "../components/SourceWorkflow";
import type { Book } from "../types";
import { type Page, type Notify } from "./shared";

/**
 * What is left of today's Downloads page, shown as Activity's Now (#516) until Now's own ticket: the server's
 * downloads, for the administrator. Its device section moved to This device (#518, `activity-device.tsx`).
 */
export function DownloadsPage({
  admin,
  books,
  refresh,
  setDetail,
  navigate,
  notify,
}: {
  admin: boolean;
  books: Book[];
  refresh: () => Promise<void>;
  setDetail: (b: Book) => void;
  navigate: (p: Page) => void;
  notify: Notify;
}) {
  if (!admin) return null;
  return (
    <AcquisitionQueue
      onReady={refresh}
      onOpenBook={(id) => {
        const b = books.find((v) => v.id === id);
        if (b) setDetail(b);
        else {
          void refresh();
          notify("Your book is joining the library. Open it in a moment.");
        }
      }}
      onBrowse={() => navigate("discover")}
      notify={notify}
    />
  );
}
