// Paste a magnet link (#606, spec #600 "Paste a magnet link"): `#book/<workId>/get/audiobook/magnet`, a Sheet over
// the Get audiobook sheet, the administrator's. Close (back to Get), the caption "Paste a magnet link", the book as on
// Get, a text area named "Magnet link" focused when the sheet opens, and Get this recording, off until the text starts
// with `magnet:?`; under it the line of getLine for a pasted link. It sends `POST /api/acquire` with the magnet, the
// book's workId and `replaceActive` when the line says it replaces the download on its way. On success both sheets
// close to the page under Get; a refusal stands above the button and the text stays.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib";
import { closeSheets } from "../navigation";
import { refreshLibraryWorks, useWork } from "../library-works-store";
import type { Route } from "../routes";
import { Button } from "../parts/Button";
import { Sheet } from "../parts/Sheet";
import { useTorrentHealth } from "../components/TorrentHealth";
import type { Acquisition } from "../types";
import { getLine } from "./get-audiobook-rows";
import { NOT_QUEUED } from "./get-audiobook-sheet";
import { GetSheetBook } from "./get-sheet-parts";
import "./get-magnet-sheet.css";

/** Get this recording is on only for a text that starts as a magnet link does. */
export function magnetReady(text: string): boolean {
  return text.trim().startsWith("magnet:?");
}

type Props = {
  workId: string;
  online: boolean;
  /** TorBox is connected: the line under the button says whether the recording may play at once. */
  torboxConfigured: boolean;
  /** The library changed: the shell reads the books again. */
  onChanged: () => Promise<void> | void;
};

export function GetMagnetSheet({ workId, online, torboxConfigured, onChanged }: Props) {
  const parent: Route = { name: "get", workId, kind: "audiobook" };
  const book: Route = { name: "book", workId };
  const { work } = useWork(workId);
  const { health } = useTorrentHealth();
  const [text, setText] = useState("");
  const [refusal, setRefusal] = useState("");
  const [getting, setGetting] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const live = useRef(true);

  // After the Sheet's own focus (its effect runs first, as a child's): the keyboard's paste is the way in.
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
    return () => {
      live.current = false;
    };
  }, []);

  const ready = magnetReady(text);
  // Shown before a link is pasted too: it says what Get this recording will do with one.
  const shown = getLine({ chosen: "magnet", mediaState: work?.mediaState, torboxConnected: torboxConfigured, health });

  const get = async () => {
    if (!ready || !work) return;
    setGetting(true);
    setRefusal("");
    try {
      if (!work.inLibrary) await api(`/works/${encodeURIComponent(workId)}/library`, { method: "PUT" });
      const job = await api<Acquisition>("/acquire", {
        method: "POST",
        body: JSON.stringify({ magnet: text.trim(), workId, ...(shown?.replaceActive ? { replaceActive: true } : {}) }),
      });
      if (job?.status === "error") throw new Error(job.error || NOT_QUEUED);
      await refreshLibraryWorks().catch(() => {});
      window.dispatchEvent(new Event("sonder:library-changed"));
      void onChanged();
      if (live.current) closeSheets(book);
    } catch (error) {
      if (live.current) setRefusal((error as Error).message || NOT_QUEUED);
      if (!work.inLibrary) {
        await refreshLibraryWorks().catch(() => {});
        window.dispatchEvent(new Event("sonder:library-changed"));
      }
    } finally {
      if (live.current) setGetting(false);
    }
  };

  const footer = (
    <>
      {refusal && (
        <p className="get-sheet-refusal type-label" role="alert">
          {refusal}
        </p>
      )}
      <Button kind="primary" disabled={!ready || getting || !online || !work} onClick={() => void get()}>
        Get this recording
      </Button>
      {shown && (
        <p className={shown.failed ? "get-sheet-line get-sheet-line-failed" : "get-sheet-line"} data-testid="get-line">
          {shown.text}
        </p>
      )}
    </>
  );

  return (
    <Sheet title="Paste a magnet link" parent={parent} footer={footer}>
      <GetSheetBook work={work ?? null} />
      <label className="get-magnet-field">
        <textarea
          ref={field}
          className="get-magnet-input"
          aria-label="Magnet link"
          placeholder="magnet:?xt=urn:btih:…"
          rows={5}
          maxLength={10000}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setRefusal("");
          }}
        />
      </label>
    </Sheet>
  );
}
