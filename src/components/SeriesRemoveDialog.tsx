import { useEffect, useState } from "react";
import { api } from "../lib";
import { Dialog } from "./ui/dialog";

type RemovalWork = {
  bookId: number;
  title: string;
  workId: string;
  introduced: boolean;
  selectedByDefault: boolean;
  otherSeries: { id: number; name: string }[];
  activeDownloads: { id: string; title: string; status: string }[];
  audioEditions: {
    editionId: string;
    releaseTitle: string | null;
    wouldDelete: boolean;
    retainReason: string | null;
  }[];
};

type RemovalPreview = { id: number; name: string; works: RemovalWork[] };

export function SeriesRemoveDialog({
  seriesId,
  open,
  onClose,
  onRemoved,
}: {
  seriesId: number | null;
  open: boolean;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [preview, setPreview] = useState<RemovalPreview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [removeWorks, setRemoveWorks] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || seriesId == null) return;
    let active = true;
    setPreview(null);
    setError("");
    setRemoveWorks(false);
    void api<RemovalPreview>(`/series/${seriesId}/removal`)
      .then((value) => {
        if (!active) return;
        setPreview(value);
        setSelected(
          value.works.filter((work) => work.selectedByDefault).map((work) => work.bookId),
        );
      })
      .catch((reason) => {
        if (active) setError((reason as Error).message);
      });
    return () => {
      active = false;
    };
  }, [open, seriesId]);

  const confirm = async () => {
    if (seriesId == null) return;
    setBusy(true);
    setError("");
    try {
      await api(`/series/${seriesId}`, {
        method: "DELETE",
        body: JSON.stringify(
          removeWorks && selected.length ? { bookIds: selected } : {},
        ),
      });
      onRemoved();
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={preview ? `Remove ${preview.name}` : "Remove series"}
      className="series-remove-dialog"
    >
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!preview && !error && <p>Loading removal options…</p>}
      {preview && (
        <>
          <label>
            <input
              type="checkbox"
              checked={removeWorks}
              onChange={(event) => setRemoveWorks(event.target.checked)}
            />
            <span>Also remove selected works and their downloaded audio</span>
          </label>
          {removeWorks && (
            <ul className="series-works">
              {preview.works.map((work) => (
                <li className="series-work" key={work.bookId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(work.bookId)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, work.bookId]
                            : current.filter((id) => id !== work.bookId),
                        )
                      }
                    />
                    <span>{work.title}</span>
                  </label>
                  <div className="series-work-meta">
                    {!work.introduced && <span>Added separately</span>}
                    {work.otherSeries.length > 0 && (
                      <span>
                        Also in{" "}
                        {work.otherSeries
                          .map((series) => `${series.name} (#${series.id})`)
                          .join(", ")}
                      </span>
                    )}
                    {work.activeDownloads.map((job) => (
                      <span key={job.id}>
                        Active download: {job.title} ({job.status})
                      </span>
                    ))}
                    {work.audioEditions.map((edition) => (
                      <span key={edition.editionId}>
                        {edition.wouldDelete
                          ? `Audio to delete: ${edition.releaseTitle || edition.editionId}`
                          : edition.retainReason}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button className="button primary" disabled={busy} onClick={() => void confirm()}>
            Remove series
          </button>
        </>
      )}
    </Dialog>
  );
}
