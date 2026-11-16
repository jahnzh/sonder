import { useState, useEffect } from "react";
import {
  Download,
  ArrowRight,
  Check,
  ShieldCheck,
  X,
  Trash2,
  HardDrive,
} from "lucide-react";
import { AcquisitionQueue } from "../components/SourceWorkflow";
import { bytes, deleteDownloads } from "../lib";
import type { Book, Download as DownloadRecord, DownloadPart } from "../types";
import { type Page, type Notify, ListenButton, Empty } from "./shared";

export type DownloadJobs = Record<string, { progress: number; chapter: number; total: number }>;

export function DownloadsPage({
  admin,
  books,
  downloads,
  downloadParts,
  downloadJobs,
  downloaded,
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
  downloaded: (b: Book) => boolean;
  refresh: () => Promise<void>;
  refreshDownloads: () => Promise<void>;
  startDownload: (b: Book) => Promise<void>;
  onPauseDownload: (b: Book) => void;
  setDetail: (b: Book) => void;
  setMediaTarget: (b: Book) => void;
  navigate: (p: Page) => void;
  notify: Notify;
}) {
  const downloadBooks = books.filter(
    (b) =>
      downloads.some((d) => d.recordingId === b.recordingId) ||
      downloadParts.some(
        (d) => d.recordingId === b.recordingId && d.loaded > 0,
      ) ||
      downloadJobs[b.recordingId],
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Downloads</h1>
        </div>
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
            Your downloads <span>{downloadBooks.length}</span>
          </h2>
          <span className="muted small">Stored on this device</span>
        </div>
        {downloadBooks.length ? (
          <div className="download-list">
            {downloadBooks.map((b) => {
              const files = downloads.filter(
                (d) => d.recordingId === b.recordingId,
              );
              const job = downloadJobs[b.recordingId];
              return (
                <div className="download-row" key={b.id}>
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
                    {job ? (
                      <>
                        <div className="download-progress">
                          <i style={{ width: `${job.progress}%` }} />
                        </div>
                        <small>
                          Downloading chapter {job.chapter} of{" "}
                          {job.total} · {Math.round(job.progress)}%
                        </small>
                      </>
                    ) : (
                      <small
                        className={
                          downloaded(b) ? "download-complete" : ""
                        }
                      >
                        {downloaded(b) ? (
                          <>
                            <Check size={13} /> Ready for offline
                            listening
                          </>
                        ) : (
                          `${files.length} of ${b.tracks.length} chapters downloaded`
                        )}{" "}
                        <span>
                          ·{" "}
                          {bytes(
                            files.reduce((a, d) => a + d.size, 0) +
                              downloadParts
                                .filter(
                                  (part) =>
                                    part.recordingId ===
                                    b.recordingId,
                                )
                                .reduce(
                                  (total, part) =>
                                    total + part.loaded,
                                  0,
                                ),
                          )}
                        </span>
                      </small>
                    )}
                  </div>
                  <div className="download-actions">
                    <button className="button subtle" aria-label={`Manage versions and sources for ${b.title}`} onClick={()=>setMediaTarget(b)}>Manage versions</button>
                    {job ? (
                      <button
                        className="button subtle"
                        onClick={() => onPauseDownload(b)}
                      >
                        <X size={15} /> Pause
                      </button>
                    ) : (
                      <>
                        {downloaded(b) ? (
                          <ListenButton book={b} compact />
                        ) : (
                          <button
                            className="button subtle"
                            onClick={() => void startDownload(b)}
                          >
                            <Download size={16} /> Finish download
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
