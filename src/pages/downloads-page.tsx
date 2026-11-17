import { useState, useEffect } from "react";
import {
  Download,
  ArrowRight,
  Check,
  ShieldCheck,
  X,
  Trash2,
  HardDrive,
  RotateCcw,
} from "lucide-react";
import { AcquisitionQueue } from "../components/SourceWorkflow";
import { bytes, deleteDownloads } from "../lib";
import type { Book, Download as DownloadRecord, DownloadPart } from "../types";
import { type Page, type Notify, ListenButton, Empty } from "./shared";
import { deviceSaveEntries, deviceSaveEntryLine, type DeviceSaveRecord, type RunningSave } from "../device-saves";

export type DownloadJobs = Record<string, { progress: number; chapter: number; total: number } & RunningSave>;

export function DownloadsPage({
  admin,
  books,
  downloads,
  downloadParts,
  downloadJobs,
  saveRecords,
  ebooks,
  refresh,
  refreshDownloads,
  startDownload,
  onPauseDownload,
  setDetail,
  setMediaTarget,
  navigate,
  notify,
}: {
  admin: boolean;
  books: Book[];
  downloads: DownloadRecord[];
  downloadParts: DownloadPart[];
  downloadJobs: DownloadJobs;
  saveRecords: DeviceSaveRecord[];
  ebooks: { id: string; workId: string; size: number }[];
  refresh: () => Promise<void>;
  refreshDownloads: () => Promise<void>;
  startDownload: (b: Book) => Promise<void>;
  onPauseDownload: (b: Book) => void;
  setDetail: (b: Book) => void;
  setMediaTarget: (b: Book) => void;
  navigate: (p: Page) => void;
  notify: Notify;
}) {
  // One entry per work from the device's books, files, running saves and records (#517); ebook-only works are kept
  // here too but have no audiobook row on this page.
  const entries = deviceSaveEntries({ books, downloads, downloadParts, running: downloadJobs, records: saveRecords, ebooks })
    .flatMap((entry) => {
      const book = entry.audio ? books.find((b) => b.id === entry.bookId) : undefined;
      return book ? [{ entry, book }] : [];
    });
  return (
    <>
      {/* Shown as Activity's Now (#516): the place's Page header holds the Title. */}
      <div className="page-heading">
        <div className="quiet-tag">
          <HardDrive size={15} />
          {bytes(downloads.reduce((a, d) => a + d.size, 0))} stored
        </div>
      </div>
      {admin && <AcquisitionQueue
        onReady={refresh}
        onOpenBook={(id) => {
          const b = books.find((v) => v.id === id);
          if (b) setDetail(b);
          else {
            void refresh();
            notify(
              "Your book is joining the library. Open it in a moment.",
            );
          }
        }}
        onBrowse={() => navigate("discover")}
        notify={notify}
      />}
      <div className="section-heading download-device-heading">
        <div>
          <h2>On this device</h2>
          <p className="queue-location">
            <Download size={14} /> Saved here for listening without an
            internet connection.
          </p>
        </div>
      </div>
      <StorageInfo downloads={downloads} />
      <section className="download-section">
        <div className="section-heading">
          <h2>
            Your downloads <span>{entries.length}</span>
          </h2>
          <span className="muted small">Stored on this device</span>
        </div>
        {entries.length ? (
          <div className="download-list">
            {entries.map(({ entry, book: b }) => {
              const line = deviceSaveEntryLine(entry);
              return (
                <div className="download-row" key={entry.workId} data-save-state={entry.state}>
                  <button
                    className="download-cover"
                    onClick={() => setDetail(b)}
                  >
                    <img src={b.cover} alt="" />
                  </button>
                  <div className="download-info">
                    <button
                      className="text-link"
                      onClick={() => setDetail(b)}
                    >
                      {b.title}
                    </button>
                    <p>{b.author}</p>
                    {entry.state === "saving" && (
                      <div className="download-progress">
                        <i style={{ width: `${Math.round(entry.progress * 100)}%` }} />
                      </div>
                    )}
                    <small className={entry.state === "complete" ? "download-complete" : ""}>
                      {entry.state === "complete" && <Check size={13} />}
                      {line}
                    </small>
                    {entry.why === "failed" && entry.reason && (
                      <small className="download-reason">{entry.reason}</small>
                    )}
                  </div>
                  <div className="download-actions">
                    <button className="button subtle" aria-label={`Audiobook of ${b.title}`} onClick={()=>setMediaTarget(b)}>Audiobook</button>
                    {entry.state === "saving" ? (
                      <button
                        className="button subtle"
                        onClick={() => onPauseDownload(b)}
                      >
                        <X size={15} /> Pause
                      </button>
                    ) : (
                      <>
                        {entry.state === "complete" ? (
                          <ListenButton book={b} compact />
                        ) : (
                          <button
                            className="button subtle"
                            onClick={() => void startDownload(b)}
                          >
                            {entry.why === "failed" ? <RotateCcw size={16} /> : <Download size={16} />}
                            {entry.why === "failed" ? " Retry" : " Resume"}
                          </button>
                        )}
                        <button
                          className="icon-button delete-download"
                          onClick={() => {
                            void deleteDownloads(b.recordingId).then(
                              () => {
                                void refreshDownloads();
                                notify(
                                  "Download removed from this device.",
                                );
                              },
                            );
                          }}
                          aria-label={`Remove download of ${b.title}`}
                        >
                          <Trash2 size={17} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={Download}
            title="No device downloads"
            text="Download a book from your library for offline playback. Keep this tab open while downloading."
            action={
              <button
                className="button primary"
                onClick={() => navigate("library")}
              >
                Choose a book <ArrowRight size={16} />
              </button>
            }
          />
        )}
      </section>
      <div className="download-note">
        <ShieldCheck size={20} />
        <div>
          <p>
            Only complete chapters are marked as downloaded. Downloads
            stay on this device; your listening progress syncs when
            you’re back online.
          </p>
        </div>
      </div>
    </>
  );
}
function StorageInfo({ downloads }: { downloads: DownloadRecord[] }) {
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [persistent, setPersistent] = useState(false);
  useEffect(() => {
    void navigator.storage?.estimate().then(setEstimate);
    void navigator.storage?.persisted?.().then(setPersistent);
  }, [downloads]);
  const size = downloads.reduce((a, d) => a + d.size, 0);
  return (
    <div className="storage-card">
      <div className="storage-icon">
        <HardDrive size={23} />
      </div>
      <div className="storage-main">
        <div>
          <strong>Device storage</strong>
          <span>
            {bytes(size)}{" "}
            {estimate?.quota
              ? `of ${bytes(estimate.quota)} available`
              : "on this device"}
          </span>
        </div>
        <div className="storage-bar">
          <i
            style={{
              width: `${size ? Math.max(1, Math.min(100, (size / (estimate?.quota || size)) * 100)) : 0}%`,
            }}
          />
        </div>
        <small>
          {persistent
            ? "Persistent storage is enabled."
            : "Your browser may clear downloads when storage is low."}{" "}
          Keep this tab open until your download finishes.
        </small>
      </div>
      <span className="quiet-tag">
        <ShieldCheck size={15} />
        {persistent ? "Protected storage" : "Browser storage"}
      </span>
    </div>
  );
}
