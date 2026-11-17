// Activity's This device (#518, spec #513 "This device"; boards ActivityDevice.dc.html, ActivityDeviceEmpty.dc.html,
// ActivityDeviceOffline.dc.html, ActivityDeviceMember.dc.html, DesktopActivityDevice.dc.html): Storage, Saving now
// and Kept on this device, for everyone. What the rows hold is decided in `device-part.ts`; this file draws it and
// asks the browser for its storage and its protection.
import { useEffect, useState, type ReactNode } from "react";
import { Trash2, WifiOff } from "lucide-react";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { BookRow } from "../parts/BookRow";
import { Button } from "../parts/Button";
import { InfoMark } from "../parts/Tooltip";
import { tip } from "../tooltip-texts";
import { bytes } from "../size-format";
import { buildDevicePart, protectedLine, usedLine, usedShare, type DeviceKeptRow } from "../device-part";
import { deviceSaveEntries, type DeviceSaveInput } from "../device-saves";
import type { Book, SavedEbook } from "../types";
import "./activity-device.css";

export type ActivityDeviceProps = {
  books: Book[];
  downloads: DeviceSaveInput["downloads"];
  downloadParts: DeviceSaveInput["downloadParts"];
  running: DeviceSaveInput["running"];
  records: DeviceSaveInput["records"];
  /** Ebook editions saved on this device for reading offline. */
  ebooks: SavedEbook[];
  online: boolean;
  /** Stops the save of one recording; what is saved stays. */
  onPause: (recordingId: string) => void;
  /** Opens a book (today's book dialog, until the Book page exists). */
  onOpen: (book: Book) => void;
  /** Removes every file of a work from this device; the place, the bookmarks and the library entry stay. */
  onRemove: (row: DeviceKeptRow) => Promise<void>;
};

/** What the browser allows and whether it protects the files. */
function useStorage(used: number) {
  const [quota, setQuota] = useState<number | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [refused, setRefused] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let live = true;
    void navigator.storage?.estimate?.().then((estimate) => live && setQuota(estimate.quota ?? null)).catch(() => {});
    void navigator.storage?.persisted?.().then((value) => live && setPersisted(value)).catch(() => {});
    return () => {
      live = false;
    };
  }, [used]);
  const ask = async () => {
    if (!navigator.storage?.persist) {
      setRefused(true);
      return;
    }
    setAsking(true);
    try {
      // Firefox asks the owner first; Chrome decides by itself (#479). The answer is what the row shows.
      const granted = await navigator.storage.persist();
      setPersisted(granted || (await navigator.storage.persisted?.().catch(() => false)) === true);
      setRefused(!granted);
    } catch {
      setRefused(true);
    } finally {
      setAsking(false);
    }
  };
  return { quota, persisted, refused, asking, ask };
}

/** A card of one or two lines in a Group: the empty Kept list and the No connection notice. */
function Note({ title, text, icon }: { title: string; text: string; icon?: ReactNode }) {
  return (
    <li className="activity-device-note">
      {icon && (
        <span className="activity-device-note-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="activity-device-note-text">
        <span className="type-body">{title}</span>
        <span className="type-label activity-device-note-line">{text}</span>
      </span>
    </li>
  );
}

function KeptRow({ row, book, onOpen, onRemove }: { row: DeviceKeptRow; book: Book | undefined; onOpen: (book: Book) => void; onRemove: ActivityDeviceProps["onRemove"] }) {
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const name = `Remove ${row.title} from this device`;
  return (
    <>
      <BookRow
        title={row.title}
        status={row.status}
        cover={row.cover}
        marks={row.notComplete ? ["audiobook"] : []}
        onClick={book ? () => onOpen(book) : undefined}
        action={
          <Button kind="quiet" icon={<Trash2 size={20} />} label={name} aria-expanded={asking} onClick={() => setAsking((open) => !open)} />
        }
      />
      {asking && (
        <li className="activity-device-confirm" role="group" aria-label={name}>
          <span className="type-body">{`Remove ${bytes(row.size)} from this device? Your place, bookmarks and library entry stay.`}</span>
          {failed && (
            <span className="type-label activity-device-failed" role="alert">
              {failed}
            </span>
          )}
          <span className="activity-device-confirm-buttons">
            <Button onClick={() => { setAsking(false); setFailed(null); }}>Cancel</Button>
            <Button
              className="activity-device-remove"
              disabled={removing}
              onClick={() => {
                setRemoving(true);
                setFailed(null);
                onRemove(row)
                  .then(() => setAsking(false))
                  .catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)))
                  .finally(() => setRemoving(false));
              }}
            >
              Remove
            </Button>
          </span>
        </li>
      )}
    </>
  );
}

export function ActivityDevice({ books, downloads, downloadParts, running, records, ebooks, online, onPause, onOpen, onRemove }: ActivityDeviceProps) {
  const entries = deviceSaveEntries({
    books,
    downloads,
    downloadParts,
    running,
    records,
    ebooks: ebooks.map((e) => ({ id: e.id, workId: e.workId, size: e.size })),
  });
  const shown = buildDevicePart({ entries, books, ebooks, online });
  const storage = useStorage(shown.used);
  const bookOf = (id: string | null) => (id ? books.find((b) => b.id === id) : undefined);
  return (
    <div className="activity-device" data-testid="activity-device">
      {!online && (
        <div className="activity-device-wide">
          <Group label="Connection">
            <Note icon={<WifiOff size={20} />} title="No connection" text="Saving goes on when the connection is back." />
          </Group>
        </div>
      )}
      <div className="activity-device-column">
        <Group caption="Storage">
          <Row
            label="Used by Sonder"
            info={<InfoMark name="Used by Sonder" text={tip("used")} />}
            value={usedLine(shown.used, storage.quota)}
            progress={usedShare(shown.used, storage.quota)}
          />
          <Row
            label="Protected storage"
            info={<InfoMark name="Protected storage" text={tip("protectedStorage")} />}
            value={protectedLine(storage)}
            control={
              storage.persisted ? undefined : (
                <Button kind="quiet" disabled={storage.asking} onClick={() => void storage.ask()} aria-label="Ask the browser to protect storage">
                  Ask
                </Button>
              )
            }
          />
        </Group>
        {shown.saving.length > 0 && (
          <Group caption="Saving now" note="Keep Sonder open while saving.">
            {shown.saving.map((row) => {
              const book = bookOf(row.bookId);
              return (
                <BookRow
                  key={row.workId}
                  title={row.title}
                  status={row.status}
                  cover={row.cover}
                  marks={["audiobook"]}
                  progress={row.progress}
                  onClick={book ? () => onOpen(book) : undefined}
                  action={<Button aria-label={`Pause saving ${row.title}`} onClick={() => onPause(row.recordingId)}>Pause</Button>}
                />
              );
            })}
          </Group>
        )}
      </div>
      <div className="activity-device-column">
        <Group caption="Kept on this device" info={<InfoMark name="Kept on this device" text={tip("kept")} />}>
          {shown.kept.length ? (
            shown.kept.map((row) => <KeptRow key={row.workId} row={row} book={bookOf(row.bookId)} onOpen={onOpen} onRemove={onRemove} />)
          ) : (
            <Note title="No books kept on this device" text="Turn on Keep on this device on a book’s page." />
          )}
        </Group>
      </div>
    </div>
  );
}
