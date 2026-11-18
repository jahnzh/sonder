// The import row of the Get sheets (#605, spec #600 "Import from this device"): "Import files from this device"
// (Get audiobook, several audio files) or "Import a file from this device" (Get ebook, one EPUB or PDF). A tap opens
// the device's file chooser and choosing starts the upload at once, in the shell's upload module (device-import.ts),
// not in the sheet. While it runs the row is a File row with its bar ("Uploading · 43%", then "Preparing the audio…"
// or "Importing…"); another book's upload leaves the row off; a refusal stands in the row in the failed colour and the
// row can be tapped again. The upload's end with the sheet open closes the sheet to the Book page.
import { useEffect, useId, useRef } from "react";
import { FileRow } from "../parts/FileRow";
import { useAddress } from "../navigation";
import { writeAddress, type Route } from "../routes";
import { deviceImportLine } from "../status-lines";
import { AUDIO_ACCEPT, EBOOK_ACCEPT, deviceImports, importRow, useDeviceImport, type ImportKind } from "../device-import";
import { RowChevron } from "./get-sheet-parts";
import "./get-import-row.css";

export const IMPORT_LABEL: Record<ImportKind, string> = {
  audiobook: "Import files from this device",
  ebook: "Import a file from this device",
};

export function GetImportRow({ kind, workId, title }: { kind: ImportKind; workId: string; title: string }) {
  const address = useAddress();
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const current = useDeviceImport();
  const row = importRow(current, kind, workId);
  const route: Route = { name: "get", workId, kind };
  const parent: Route = { name: "book", workId };
  const addressRef = useRef(address);
  addressRef.current = address;

  // While the sheet is open its book's upload ends here: the sheet closes to the Book page.
  useEffect(
    () =>
      deviceImports.watch(kind, workId, () => {
        if (location.hash === writeAddress(route)) addressRef.current.goBack(parent);
      }),
    [kind, workId],
  );

  const label = IMPORT_LABEL[kind];
  if (row.state === "running")
    return (
      <FileRow
        kind={kind}
        name={label}
        status={deviceImportLine({ kind, phase: row.phase, progress: row.progress }) ?? ""}
        progress={row.progress}
      />
    );
  const off = row.state === "waiting" || !title;
  return (
    <li className="part-row-item">
      <button
        type="button"
        className={`part-row get-sheet-import${off ? " get-sheet-off" : ""}`}
        data-opens=""
        aria-disabled={off ? "true" : undefined}
        aria-describedby={row.state === "failed" ? errorId : undefined}
        onClick={() => {
          if (off) return;
          input.current?.click();
        }}
      >
        <span className="get-sheet-import-text">
          <span className="part-row-label type-body">{label}</span>
          {row.state === "failed" && (
            <span id={errorId} className="get-sheet-import-refusal type-label" role="alert">
              {row.error}
            </span>
          )}
        </span>
        <span className="part-row-value type-label">
          <RowChevron />
        </span>
      </button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        aria-label={label}
        data-import={kind}
        multiple={kind === "audiobook"}
        accept={kind === "audiobook" ? AUDIO_ACCEPT : EBOOK_ACCEPT}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          // The same files can be chosen again after a refusal.
          event.target.value = "";
          if (files.length) deviceImports.start(kind, workId, title, files);
        }}
      />
    </li>
  );
}
