// The chooser of a downloaded series pack's files for the book (ADR 0027, #899), on the Get audiobook sheet. A pack
// that holds the book but whose split could not tell which of its files are the book's lists its folders and files
// (`GET /api/works/<id>/pack`); the owner switches on the book's and Use these files makes its recording from them
// (`POST /api/works/<id>/pack`). Nothing shows while no pack waits for this book.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib";
import { Button } from "../parts/Button";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Switch } from "../parts/Switch";
import { packUnitDetail, type PackChoice } from "./get-audiobook-rows";
import "./get-pack-choice.css";

export function GetPackChoice({ workId, online, onChosen }: { workId: string; online: boolean; onChosen: () => Promise<void> | void }) {
  const [choice, setChoice] = useState<PackChoice | null>(null);
  const [on, setOn] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void api<{ choices?: PackChoice[] }>(`/works/${encodeURIComponent(workId)}/pack`).then(
      (answer) => live.current && setChoice(Array.isArray(answer?.choices) ? (answer.choices[0] ?? null) : null),
      // An older server has no such route: nothing to choose.
      () => {},
    );
    return () => {
      live.current = false;
    };
  }, [workId]);
  if (!choice?.units.length) return null;

  const toggle = (key: string, next: boolean) => {
    const set = new Set(on);
    if (next) set.add(key);
    else set.delete(key);
    setOn(set);
    setRefusal("");
  };
  const use = async () => {
    setBusy(true);
    setRefusal("");
    try {
      await api(`/works/${encodeURIComponent(workId)}/pack`, {
        method: "POST",
        body: JSON.stringify({ acquisitionId: choice.acquisitionId, units: [...on] }),
      });
      if (live.current) setChoice(null);
      await onChosen();
    } catch (error) {
      if (live.current) setRefusal((error as Error).message || "These files could not be used.");
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <div className="get-pack-choice" data-testid="pack-choice">
      <Group caption="In a downloaded pack" note={`${choice.title}: switch on this book's files.`}>
        {choice.units.map((unit) => (
          <Row
            key={unit.key}
            label={unit.label}
            detail={packUnitDetail(unit)}
            control={<Switch label={unit.label} on={on.has(unit.key)} disabled={busy} onChange={(next) => toggle(unit.key, next)} />}
          />
        ))}
      </Group>
      {refusal && (
        <p className="get-sheet-refusal type-label" role="alert">
          {refusal}
        </p>
      )}
      <Button kind="secondary" className="get-pack-choice-use" disabled={!on.size || busy || !online} onClick={() => void use()}>
        Use these files
      </Button>
    </div>
  );
}
