// Plays from on Now playing's Listen face (#593, spec #586 "The Listen face"; ADR 0015): the delivery source picker
// of the Audiobook page (#530), the same choices (audiobook-model.ts, playsFromOptions) in the same list. A choice is
// stored for the recording on this device and, when it is the one playing, the player switches its source and keeps
// its place (`setPlaybackSource`).
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "../components/ui/dialog";
import { Row } from "../parts/Row";
import { InfoMark } from "../parts/Tooltip";
import { usePlayer } from "../player";
import { deviceFault, getRecordingSources, preferredSource, setPreferredSource } from "../playback-sources";
import { tip } from "../tooltip-texts";
import type { Book, Download, MediaFault, PlaybackSourceChoice, RecordingSources } from "../types";
import { PLAYS_FROM_NAMES, playsFromOptions, type Faults } from "./audiobook-model";
import { PickList } from "./audiobook-page";

function Chevron() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function PlaysFromRow({ book, downloads, online }: { book: Book; downloads: Download[]; online: boolean }) {
  const p = usePlayer();
  const [sources, setSources] = useState<RecordingSources | null>(null);
  const [preference, setPreference] = useState<PlaybackSourceChoice>("auto");
  const [deviceMark, setDeviceMark] = useState<MediaFault | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const reading = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++reading.current;
    const [next, choice, mark] = await Promise.all([getRecordingSources(book), preferredSource(book.recordingId), deviceFault(book.recordingId)]);
    if (request !== reading.current) return;
    setSources(next);
    setPreference(choice);
    setDeviceMark(mark);
  }, [book]);
  useEffect(() => {
    setSources(null);
    void refresh().catch(() => {});
    const changed = () => void refresh().catch(() => {});
    window.addEventListener("sonder:downloads-changed", changed);
    window.addEventListener("online", changed);
    return () => {
      reading.current++;
      window.removeEventListener("sonder:downloads-changed", changed);
      window.removeEventListener("online", changed);
    };
  }, [book.recordingId]);
  const faults: Faults = { ...(sources?.faults ?? book.faults ?? {}), ...(deviceMark ? { device: deviceMark } : {}) };
  const playsThis = p.book?.recordingId === book.recordingId;
  const placeTrack = playsThis ? p.track : book.tracks.find((track) => track.id === book.progress?.trackId) ?? book.tracks[0];
  const available = sources?.tracks.find((track) => track.id === placeTrack?.id);
  const options = playsFromOptions({
    faults,
    deviceHasTrack: downloads.some((file) => file.recordingId === book.recordingId && file.trackId === placeTrack?.id),
    serverHasTrack: !!available?.server,
    originalHasTrack: !!available?.original,
    online,
  });
  const choose = async (choice: PlaybackSourceChoice) => {
    setOpen(false);
    setBusy(true);
    try {
      await setPreferredSource(book.recordingId, choice);
      setPreference(choice);
      if (playsThis) await p.setPlaybackSource(choice);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        label="Plays from"
        info={<InfoMark name="Plays from" text={tip("playsFrom")} />}
        control={
          <button type="button" className="now-playing-opens type-label" aria-label="Plays from" disabled={!sources || busy} onClick={() => setOpen(true)}>
            {PLAYS_FROM_NAMES[preference]}
            <Chevron />
          </button>
        }
      />
      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)} title="Plays from" className="audiobook-dialog">
        <PickList label="Plays from" options={options} value={preference} onChoose={(value) => void choose(value)} />
      </Dialog>
    </>
  );
}
