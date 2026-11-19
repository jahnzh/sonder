// The per-field comparison (#719 part b): the book now against one provider's result, a row per field (title,
// subtitle, authors, series, genres, publisher, year, language, ISBN, ASIN, description, cover) and one per recording's
// narrators, each with its checkbox. 'Fill only what's missing' is ticked when it opens; Take all and Take none tick the
// rest or nothing; Apply writes the ticked rows from that provider. Covers are shown by their address.
// Words and steps: src/pages/metadata-compare-model.ts. Used on the Edit page and the Match page.
import { useEffect, useState } from "react";
import { api } from "../lib";
import { Group } from "../parts/Group";
import { Button } from "../parts/Button";
import { MATCH_FIELDS, type MatchField, type MatchRow, type MetadataApplied, type MetadataComparison, type MetadataProvider, type WorkMetadata } from "../types";
import { PROVIDER_NAMES } from "../catalogue-page-model";
import {
  APPLY,
  APPLYING,
  COMPARE_TITLE,
  NARRATORS,
  NOW,
  SAME,
  TICK_ALL,
  TICK_MISSING,
  TICK_NONE,
  allTicks,
  appliedLine,
  applyBody,
  defaultTicks,
  fieldLabel,
  takeable,
  toggled,
  valueText,
  type Ticks,
} from "./metadata-compare-model";
import "./metadata-compare.css";

type Props = { workId: string; provider: MetadataProvider; id: string; onApplied: (metadata: WorkMetadata | null) => void; onClose: () => void };

function CompareRow({ name, field, row, on, onChange, testId, provider }: { name: string; field: MatchField | "narrators"; row: MatchRow; on: boolean; onChange: (on: boolean) => void; testId: string; provider: MetadataProvider }) {
  const can = takeable(row);
  const cover = field === "cover";
  return (
    <li className="part-row-item compare-row" data-testid={testId} data-ticked={on ? "" : undefined}>
      <label className="compare-label">
        <input type="checkbox" className="compare-check" checked={on} disabled={!can} onChange={(event) => onChange(event.target.checked)} aria-label={`Take ${name}`} />
        <span className="compare-name type-body">{name}</span>
      </label>
      <div className="compare-values">
        <span className="compare-now type-label">
          <span className="compare-key">{NOW}</span>
          {cover && row.current ? <img className="compare-cover" src={String(row.current)} alt="" /> : <span className="compare-text">{valueText(field, row.current)}</span>}
        </span>
        <span className="compare-found type-label" data-same={row.same ? "" : undefined}>
          <span className="compare-key">{row.same ? SAME : PROVIDER_NAMES[provider]}</span>
          {cover && row.found ? <img className="compare-cover" src={String(row.found)} alt="" loading="lazy" /> : <span className="compare-text">{row.same ? "" : valueText(field, row.found, true)}</span>}
        </span>
      </div>
    </li>
  );
}

export function MetadataCompare({ workId, provider, id, onApplied, onClose }: Props) {
  const [comparison, setComparison] = useState<MetadataComparison | null>(null);
  const [ticks, setTicks] = useState<Ticks>({ fields: [], narrators: [] });
  const [line, setLine] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setComparison(null);
    setLine(null);
    void api<MetadataComparison>(`/works/${encodeURIComponent(workId)}/metadata/match?${new URLSearchParams({ provider, id })}`)
      .then((value) => {
        if (!live) return;
        setComparison(value);
        setTicks(defaultTicks(value));
      })
      .catch((error: Error) => live && setLine({ text: error.message, failed: true }));
    return () => {
      live = false;
    };
  }, [workId, provider, id]);
  const apply = async () => {
    if (!comparison) return;
    setBusy(true);
    setLine({ text: APPLYING, failed: false });
    try {
      const result = await api<MetadataApplied>(`/works/${encodeURIComponent(workId)}/metadata/match`, { method: "POST", body: JSON.stringify(applyBody(comparison, ticks)) });
      setLine(appliedLine(result));
      onApplied(result.metadata);
    } catch (error) {
      setLine({ text: (error as Error).message, failed: true });
    } finally {
      setBusy(false);
    }
  };
  const count = ticks.fields.length + ticks.narrators.length;
  return (
    <section className="compare" data-testid="metadata-compare" aria-label={`${COMPARE_TITLE} ${PROVIDER_NAMES[provider]}`}>
      {!comparison ? (
        line && (
          <p className="hardcover-page-line type-label" data-failed={line.failed ? "" : undefined} role={line.failed ? "alert" : "status"}>
            {line.text}
          </p>
        )
      ) : (
        <>
          <Group caption={`${COMPARE_TITLE} ${PROVIDER_NAMES[provider]} · ${comparison.title}`}>
            {MATCH_FIELDS.map((field) => (
              <CompareRow
                key={field}
                name={fieldLabel(field)}
                field={field}
                row={comparison.fields[field]}
                on={ticks.fields.includes(field)}
                testId={`compare-${field}`}
                provider={provider}
                onChange={(on) => setTicks((previous) => toggled(previous, "field", field, on))}
              />
            ))}
            {comparison.recordings.map((recording) => (
              <CompareRow
                key={recording.recordingId}
                name={comparison.recordings.length > 1 ? `${NARRATORS} · ${recording.label}` : NARRATORS}
                field="narrators"
                row={recording}
                on={ticks.narrators.includes(recording.recordingId)}
                testId={`compare-narrators-${recording.recordingId}`}
                provider={provider}
                onChange={(on) => setTicks((previous) => toggled(previous, "narrators", recording.recordingId, on))}
              />
            ))}
          </Group>
          <div className="edit-actions compare-actions">
            <Button kind="quiet" disabled={busy} onClick={() => setTicks(defaultTicks(comparison))}>
              {TICK_MISSING}
            </Button>
            <Button kind="quiet" disabled={busy} onClick={() => setTicks(allTicks(comparison))}>
              {TICK_ALL}
            </Button>
            <Button kind="quiet" disabled={busy} onClick={() => setTicks({ fields: [], narrators: [] })}>
              {TICK_NONE}
            </Button>
          </div>
          <div className="edit-actions compare-actions">
            <Button kind="secondary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button kind="primary" disabled={busy || !count} onClick={() => void apply()}>
              {count ? `${APPLY} · ${count}` : APPLY}
            </Button>
          </div>
          {line && (
            <p className="hardcover-page-line type-label" data-failed={line.failed ? "" : undefined} role={line.failed ? "alert" : "status"}>
              {line.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
