// The reader's hook for its narration map (#543): src/reader-map.ts decides, this gives it the player, the recording
// saved for the ebook, one map lifecycle for the mounted reader and the browser's timers.
import { useEffect, useRef, useState } from "react";
import { createAlignmentMapLifecycle } from "./alignment-map-lifecycle";
import { alignmentMapDeps } from "./alignment-map-deps";
import { userStorageKey } from "./lib";
import { usePlayer } from "./player";
import { createReaderMapLoader, readerMapRecording, savedRecordingKey } from "./reader-map";
import type { AlignmentJob, ReaderBook } from "./reading-types";
import type { Book } from "./types";

/**
 * Loads the map of the reader's ebook for one recording and hands it to `onMap`: the recording the reader is given
 * (`recordingId`, saved for this ebook), or else the rule of {@link readerMapRecording}, decided once the ebook is
 * there. Returns the recording it loads ("" when there is none).
 */
export function useReaderMap(
  book: ReaderBook | null,
  books: Book[],
  recordingId: string | undefined,
  onMap: (job: AlignmentJob | null, confirmed: boolean) => void,
): string {
  const player = usePlayer();
  const onMapRef = useRef(onMap);
  onMapRef.current = onMap;
  // One lifecycle for the mounted reader: its server-confirmation history spans recording changes.
  const loader = useRef<ReturnType<typeof createReaderMapLoader> | null>(null);
  loader.current ??= createReaderMapLoader({
    lifecycle: createAlignmentMapLifecycle(alignmentMapDeps("reader")),
    onMap: (job, confirmed) => onMapRef.current(job, confirmed),
    setInterval: (run, ms) => window.setInterval(run, ms),
    clearInterval: (timer) => window.clearInterval(timer as number),
  });
  // null until the ebook is there: then the recording is chosen once, by the player and the saved choice.
  const [selected, setSelected] = useState<string | null>(null);
  const saved = (ebookId: string) => localStorage.getItem(userStorageKey(savedRecordingKey(ebookId)));
  if (book && selected === null) {
    const playing = player.book ? { workId: player.book.workId, recordingId: player.book.recordingId } : null;
    setSelected(readerMapRecording(book, books, saved(book.id), playing));
  }
  const ready = !!book && selected !== null;
  // The recording the reader is given wins, and is saved for this ebook.
  useEffect(() => {
    if (!book || selected === null || !recordingId || recordingId === selected) return;
    localStorage.setItem(userStorageKey(savedRecordingKey(book.id)), recordingId);
    loader.current!.forget();
    setSelected(recordingId);
  }, [recordingId, ready]);
  useEffect(() => {
    if (!book || selected === null) return;
    void loader.current!.load({ id: book.id, fingerprint: book.fingerprint }, selected);
    return () => loader.current!.stop();
  }, [book?.id, selected]);
  // No recording yet: one of the work that arrives later in the library is taken up.
  useEffect(() => {
    if (!book || selected !== "") return;
    const matching = readerMapRecording(book, books, saved(book.id), null);
    if (matching) setSelected(matching);
  }, [books, book?.workId]);
  return selected ?? "";
}
