// The Ebook page (#531, spec #526 "The Ebook page"; board Ebook.dc.html): `#book/<workId>/ebook`. Editions as choice
// rows with their check against the narration, the chosen one ticked; a PDF opens its file in a new tab; Get another
// edition (administrator) and Import a file; Available from (this device's copy and the server's, with sizes; the
// device copy is removed after one question); Export the file. The rules are in src/ebook-choice.ts.
//
// Also the Ebook row (`EbookFileRow`) that today's book dialog shows in place of its "Find ebook" row: the edition's
// line, or "Not added" and Get, opening this page.
import { useRef, useState } from "react";
import { Dialog } from "../components/ui/dialog";
import { api, ApiError } from "../lib";
import { useWork } from "../library-works-store";
import {
  chosenEbook,
  choiceTarget,
  ebookRowLine,
  editionDetail,
  editionLabel,
  overruledByShared,
  PDF_LINE,
  shownEdition,
} from "../ebook-choice";
import { removeEbookFromDevice, setDeviceEbookChoice, useDeviceEbookChoice, useEbookDeviceCopy } from "../ebook-device-copy";
import { checkingNote, type EbookSetMember } from "../ebook-set";
import { Button } from "../parts/Button";
import { ChoiceGroup } from "../parts/ChoiceRow";
import { FileRow } from "../parts/FileRow";
import { Group } from "../parts/Group";
import { Chevron } from "../parts/icons";
import { PageHeader } from "../parts/PageHeader";
import { Row } from "../parts/Row";
import { InfoMark } from "../parts/Tooltip";
import { bytes } from "../size-format";
import { tip } from "../tooltip-texts";
import type { Book, LibraryWork } from "../types";
import "./ebook-page.css";

/** The address of an edition's file. The server sends it as an attachment, so it opens in another app. */
export const ebookFileUrl = (id: string) => `/api/ebooks/${encodeURIComponent(id)}/file`;

/**
 * Today's ebook search takes a book of `GET /api/books` as its target and reads only its work, title and author. A
 * work with no audio edition has none there: this stands in for it.
 */
export function ebookSearchTarget(work: LibraryWork): Book {
  return {
    id: work.workId,
    workId: work.workId,
    editionId: "",
    recordingId: "",
    title: work.title,
    author: work.author,
    narrator: "",
    description: work.description,
    cover: work.cover,
    genre: work.genre,
    duration: 0,
    rating: 0,
    year: work.year,
    tracks: [],
    inLibrary: work.inLibrary,
    status: "unread",
    addedAt: work.addedAt ?? 0,
    serverStored: false,
    sourceLabel: "",
  };
}

/** The file chooser's types: an EPUB or a PDF, as today's import takes. */
const IMPORT_TYPES = ".epub,.pdf,application/epub+zip,application/pdf";

/** A line under a group: what the last action on it came to. */
type Note = { text: string; failed: boolean } | null;

/** The line under a group with what its last action came to; a failure in the failed colour. */
function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <p className="ebook-page-note" role={note.failed ? "alert" : "status"} data-failed={note.failed ? "" : undefined}>
      {note.text}
    </p>
  );
}

function download(id: string) {
  const link = document.createElement("a");
  link.href = ebookFileUrl(id);
  link.download = "";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

export function EbookPage({
  workId,
  admin,
  onGetEdition,
}: {
  workId: string;
  admin: boolean;
  /** Today's ebook search for the work (until slice "Get", S8). */
  onGetEdition: (work: LibraryWork) => void;
}) {
  const { work, status, reload } = useWork(workId);
  const deviceChoice = useDeviceEbookChoice(workId);
  const shown = work ? shownEdition(work, deviceChoice) : null;
  const device = useEbookDeviceCopy(shown?.id ?? null);
  const [editionsNote, setEditionsNote] = useState<Note>(null);
  const [deviceNote, setDeviceNote] = useState<Note>(null);
  const [importing, setImporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const header = <PageHeader title="Ebook" back parent={{ name: "book", workId }} />;
  if (!work)
    return (
      <div className="ebook-page" data-status={status}>
        {header}
        {status === "loading" ? <p className="ebook-page-book type-label">Loading…</p> : null}
      </div>
    );

  const chosen = chosenEbook(work, deviceChoice);
  const epubs = work.ebooks.filter((ebook) => ebook.format === "epub");
  const others = work.ebooks.filter((ebook) => ebook.format !== "epub");
  const hasRecording = work.recordings.length > 0;

  const choose = async (ebookId: string) => {
    const ebook = work.ebooks.find((entry) => entry.id === ebookId);
    if (!ebook || choosing || ebookId === chosen?.id) return;
    setEditionsNote(null);
    if (choiceTarget(admin, ebook) === "shared") {
      setChoosing(true);
      try {
        await api(`/works/${encodeURIComponent(workId)}/ebook-set/default`, {
          method: "PATCH",
          body: JSON.stringify({ ebookId }),
        });
        await reload();
        return;
      } catch (error) {
        // The server refused it as the shared default: it stays this device's choice.
        if (!(error instanceof ApiError)) {
          setEditionsNote({ text: (error as Error).message, failed: true });
          return;
        }
      } finally {
        setChoosing(false);
      }
    }
    setDeviceEbookChoice(workId, ebookId);
    if (overruledByShared(work, ebookId))
      setEditionsNote({ text: "Only an edition that matches the narration can be the default.", failed: true });
  };

  const importFile = async (file: File) => {
    setImporting(true);
    setEditionsNote(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await api<{ alreadySaved: boolean; ebookSet?: { status: EbookSetMember["status"] } }>(
        `/ebooks/import?workId=${encodeURIComponent(workId)}`,
        { method: "POST", body },
      );
      await reload();
      window.dispatchEvent(new Event("sonder:library-changed"));
      setEditionsNote({
        text:
          (response.alreadySaved ? "This ebook is already on your server." : "Saved on your server.") +
          checkingNote(response.ebookSet),
        failed: false,
      });
    } catch (error) {
      setEditionsNote({ text: (error as Error).message, failed: true });
    } finally {
      setImporting(false);
    }
  };

  const removeDeviceCopy = async () => {
    if (!shown) return;
    setConfirming(false);
    try {
      await removeEbookFromDevice(shown.id);
      setDeviceNote({ text: "Removed from this device.", failed: false });
    } catch (error) {
      setDeviceNote({ text: (error as Error).message, failed: true });
    }
    device.read();
  };

  return (
    <div className="ebook-page" data-status={status}>
      {header}
      <p className="ebook-page-book type-label">{work.title}</p>
      <Group
        caption="Editions"
        info={<InfoMark name="Editions" text={tip("editions")} />}
      >
        {epubs.length > 0 && (
          <li className="ebook-page-choices">
            <ChoiceGroup
              label="Editions"
              value={chosen?.id ?? null}
              options={epubs.map((ebook) => ({
                value: ebook.id,
                label: editionLabel(ebook),
                detail: editionDetail(ebook, hasRecording),
              }))}
              onChange={(id) => void choose(id)}
            />
          </li>
        )}
        {others.map((ebook) => (
          <Row
            key={ebook.id}
            label={editionLabel(ebook)}
            value={PDF_LINE}
            opens
            onClick={() => window.open(ebookFileUrl(ebook.id), "_blank", "noopener")}
          />
        ))}
        {admin && <Row label="Get another edition" opens onClick={() => onGetEdition(work)} />}
        <Row
          label="Import a file"
          value={importing ? "Importing" : undefined}
          opens
          disabled={importing}
          onClick={() => fileInput.current?.click()}
        />
      </Group>
      <NoteLine note={editionsNote} />
      <input
        ref={fileInput}
        className="ebook-page-file"
        type="file"
        accept={IMPORT_TYPES}
        aria-label="Ebook file to import"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
      {shown && (device.size != null || shown.available) && (
        <Group
          caption="Available from"
          info={<InfoMark name="Available from" text={tip("ebookFrom")} />}
        >
          {device.size != null && (
            <Row label="Device copy" value={bytes(device.size)} opens onClick={() => setConfirming(true)} />
          )}
          {shown.available && <Row label="Server copy" value={shown.size > 0 ? bytes(shown.size) : undefined} />}
        </Group>
      )}
      <NoteLine note={deviceNote} />
      {shown?.available && (
        <Group label="Export">
          <Row
            label="Export the file"
            info={<InfoMark name="Export the file" text={tip("exportFile")} />}
            control={<Button kind="quiet" icon={<Chevron />} label="Export the file" onClick={() => download(shown.id)} />}
          />
        </Group>
      )}
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        title="Remove from this device?"
        description="Your place and the library entry stay."
        className="ebook-page-dialog"
      >
        <div className="ebook-page-dialog-actions">
          <Button kind="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void removeDeviceCopy()}>
            Remove from this device
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The Ebook row of today's book dialog (#531): the chosen edition's line, opening the Ebook page; without any
 * edition "Not added" and, for the administrator, Get, which opens today's ebook search.
 */
export function EbookFileRow({
  workId,
  admin,
  onOpen,
  onGet,
}: {
  workId: string;
  admin: boolean;
  onOpen: () => void;
  onGet: () => void;
}) {
  const { work } = useWork(workId);
  const deviceChoice = useDeviceEbookChoice(workId);
  const chosen = work ? chosenEbook(work, deviceChoice) : null;
  const device = useEbookDeviceCopy(chosen?.id ?? null);
  const ebooks = work?.ebooks ?? [];
  const line = ebookRowLine({ ebooks, chosenEbookId: work?.chosenEbookId ?? null }, deviceChoice, device.size);
  return (
    <div className="ebook-file-row">
    <Group label="Ebook">
      {ebooks.length ? (
        <FileRow kind="ebook" name="Ebook" status={line} onClick={onOpen} />
      ) : (
        <FileRow
          kind="ebook"
          name="Ebook"
          status={line}
          action={
            admin ? (
              <Button aria-label="Get an ebook" onClick={onGet}>
                Get
              </Button>
            ) : undefined
          }
        />
      )}
    </Group>
    </div>
  );
}
