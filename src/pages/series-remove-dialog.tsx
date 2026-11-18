// Remove series (#566, spec #560 "Remove series"; board SeriesRemove.dc.html): a confirmation over the Series page,
// with no address (ADR 0020); on a phone it stands at the foot of the screen, on a desktop it is centred and 480
// wide. The title "Remove <name>?", the note, for the administrator the switch "Remove the books it added" (off when
// it opens) and, while it is on, the books the series added as choice rows; then the button and Cancel. What it shows
// and sends is series-remove-model.ts; only the administrator reads `GET /api/series/<id>/removal`.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib";
import { Button } from "../parts/Button";
import { ChoiceList } from "../parts/ChoiceRow";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Switch } from "../parts/Switch";
import { seriesRemoveModel, type SeriesRemovalPreview, type SeriesRemoveManual } from "./series-remove-model";
import "./series-remove-dialog.css";

type Props = {
  seriesId: number;
  /** The series' name as the page shows it. */
  name: string;
  admin: boolean;
  online: boolean;
  open: boolean;
  onClose: () => void;
  /** `DELETE /api/series/<id>` answered: the page is gone. */
  onRemoved: () => void;
};

export function SeriesRemoveDialog({ seriesId, name, admin, online, open, onClose, onRemoved }: Props) {
  const [preview, setPreview] = useState<SeriesRemovalPreview | null>(null);
  const [on, setOn] = useState(false);
  const [manual, setManual] = useState<SeriesRemoveManual>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Each opening starts with the switch off and the server's choice; the administrator's preview is read again.
  useEffect(() => {
    if (!open) return;
    setOn(false);
    setManual({});
    setError("");
    setPreview(null);
    if (!admin) return;
    let active = true;
    void api<SeriesRemovalPreview>(`/series/${seriesId}/removal`)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((reason) => {
        if (active) setError((reason as Error).message);
      });
    return () => {
      active = false;
    };
  }, [open, admin, seriesId]);

  const model = useMemo(() => seriesRemoveModel({ name, preview, admin, on, manual }), [name, preview, admin, on, manual]);

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/series/${seriesId}`, { method: "DELETE", body: JSON.stringify(model.body) });
      onRemoved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="series-remove-overlay" />
        <DialogPrimitive.Content
          className="series-remove"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // The dialog itself takes focus, so Space or Enter never removes the series by accident.
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          }}
        >
          <div className="series-remove-head">
            <DialogPrimitive.Title className="series-remove-title type-heading">{model.title}</DialogPrimitive.Title>
            <p className="series-remove-note type-label">{model.note}</p>
          </div>
          {model.switch && (
            <div className="series-remove-switch">
              <Group label={model.switch.label}>
                <Row label={model.switch.label} control={<Switch label={model.switch.label} on={model.switch.on} disabled={busy} onChange={setOn} />} />
              </Group>
            </div>
          )}
          {model.caption && (
            <div className="series-remove-books">
              <h3 className="series-remove-caption type-caption">{model.caption}</h3>
              <ChoiceList
                label={model.caption}
                options={model.choices.map((choice) => ({ value: String(choice.bookId), label: choice.title, detail: choice.detail, chosen: choice.chosen }))}
                onToggle={(value, chosen) => setManual((current) => ({ ...current, [Number(value)]: chosen }))}
              />
            </div>
          )}
          {error && (
            <p className="series-remove-error type-label" role="alert">
              {error}
            </p>
          )}
          <div className="series-remove-actions">
            <Button kind="secondary" className="series-remove-confirm" disabled={busy || !online} onClick={() => void confirm()}>
              {model.button}
            </Button>
            <DialogPrimitive.Close asChild>
              <Button kind="quiet" disabled={busy}>
                Cancel
              </Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
