// The Add sheet of a saved series (#563, spec #560 "The Add sheet"; board SeriesAdd.dc.html), and the Save series sheet
// of one that is not saved (#564, board SeriesSave.dc.html): `#series/<id>/add`, a full-screen Sheet over the Series
// page. Close and "Add to library" (or "Save series"); the stacked cover, the name and the author; Not
// in your library · N as choice rows; For the books you add: the administrator's Get switches, then Preferred
// language; the button "Add N books" with its note. The words and rules are in series-add-model.ts.
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib";
import { useStoredWorksWithPlaces } from "../library-works-store";
import { goBack, navigate } from "../navigation";
import { Button } from "../parts/Button";
import { ChoiceList } from "../parts/ChoiceRow";
import { Group } from "../parts/Group";
import { Row } from "../parts/Row";
import { Sheet } from "../parts/Sheet";
import { Switch } from "../parts/Switch";
import { InfoMark } from "../parts/Tooltip";
import { normalizeSeriesLanguage } from "../series-selection";
import { tip } from "../tooltip-texts";
import { ADD_SHEET_TITLE, SAVE_SHEET_TITLE, seriesAddModel, type SeriesAddManual, type SeriesAddOpening, type SeriesAddSeries } from "./series-add-model";
import "./series-add-sheet.css";

/** The Get switches as the administrator last set them on this device; off the first time. */
export const SERIES_GET_AUDIO_KEY = "sonder-series-get-audio";
export const SERIES_GET_EBOOKS_KEY = "sonder-series-get-ebooks";
function stored(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function store(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // A device without storage keeps the switch for this sheet only.
  }
}

/**
 * The book a row's Add asked for, by series, until the sheet opens. Held in memory only: a reload (or a link) opens
 * the sheet with the server's `selected`.
 */
const askedFor = new Map<string, string>();

/** A row's Add: the sheet opens with that book chosen. */
export function openAddSheet(seriesId: string, bookId: string) {
  askedFor.set(seriesId, bookId);
  navigate({ name: "series-add", id: String(seriesId) });
}

/** Save series, on a series that is not saved: the sheet opens with the defaults chosen. */
export function openSaveSheet(seriesId: string) {
  askedFor.delete(seriesId);
  navigate({ name: "series-add", id: String(seriesId) });
}

/** How the sheet that opens now was opened (the sheet forgets the row's Add once it closes). */
function openingOf(seriesId: string): SeriesAddOpening {
  const bookId = askedFor.get(seriesId);
  return bookId === undefined ? { from: "address" } : { from: "row", bookId };
}

function languageName(language: string) {
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(language) || language;
  } catch {
    return language;
  }
}

function deviceLanguage() {
  return normalizeSeriesLanguage(navigator.language || "en") || "en";
}

function Chevron() {
  return (
    <svg className="part-row-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** The stacked cover: the covers of the first three numbers, the first in front. */
function StackedCover({ covers }: { covers: (string | null)[] }) {
  const shown = [0, 1, 2].map((index) => covers[index] ?? null);
  return (
    <span className="series-add-stack" aria-hidden="true">
      {shown
        .map((cover, index) => (
          <span key={index} className="series-add-stack-cover" data-place={index}>
            {cover && <img src={cover} alt="" />}
          </span>
        ))
        .reverse()}
    </span>
  );
}

type Props = {
  seriesId: string;
  series: SeriesAddSeries | null;
  /** The series is saved; false for the Save series sheet of a series that is not saved. */
  saved: boolean;
  admin: boolean;
  online: boolean;
  /** The preferred language; the sheet changes it for the page too. */
  language: string;
  onLanguage: (language: string) => void;
  /** The books were added: the page reads the series and the library again. */
  onAdded: () => void;
};

export function SeriesAddSheet({ seriesId, series, saved, admin, online, language, onLanguage, onAdded }: Props) {
  const library = useStoredWorksWithPlaces();
  const [opening] = useState(() => openingOf(seriesId));
  useEffect(() => () => void askedFor.delete(seriesId), [seriesId]);
  const [manual, setManual] = useState<SeriesAddManual>({});
  const [getAudio, setGetAudio] = useState(() => stored(SERIES_GET_AUDIO_KEY));
  const [getEbooks, setGetEbooks] = useState(() => stored(SERIES_GET_EBOOKS_KEY));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const model = useMemo(
    () =>
      series
        ? seriesAddModel(series, { saved, library, admin, language, deviceLanguage: deviceLanguage(), opening, manual, getAudio, getEbooks })
        : null,
    [series, saved, library, admin, language, opening, manual, getAudio, getEbooks],
  );

  const add = async () => {
    if (!model || model.button.disabled) return;
    setBusy(true);
    setError("");
    try {
      await api("/series", { method: "POST", body: JSON.stringify(model.body) });
      onAdded();
      goBack({ name: "series", id: String(seriesId) });
    } catch (reason) {
      // The server's message, above the button; the choice stays.
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const footer = model ? (
    <>
      {error && (
        <p className="series-add-error type-label" role="alert">
          {error}
        </p>
      )}
      <Button kind="primary" disabled={model.button.disabled || busy || !online} onClick={() => void add()}>
        {model.button.label}
      </Button>
      {model.note && <p className="series-add-note">{model.note}</p>}
    </>
  ) : undefined;

  return (
    <Sheet title={model?.title ?? (saved ? ADD_SHEET_TITLE : SAVE_SHEET_TITLE)} parent={{ name: "series", id: String(seriesId) }} footer={footer}>
      {!model ? (
        <p className="type-label series-add-loading">Loading…</p>
      ) : (
        <>
          <div className="series-add-head">
            <StackedCover covers={model.covers} />
            <div className="series-add-name">
              <h1 className="type-heading">{model.name}</h1>
              {model.author && <p className="type-label">{model.author}</p>}
            </div>
          </div>

          <div className="part-group-block">
            <h2 className="part-group-caption type-caption">{model.caption}</h2>
            {model.choices.length > 0 && (
              <ChoiceList
                label={model.caption}
                options={model.choices.map((choice) => ({ value: choice.key, label: choice.title, detail: choice.detail, chosen: choice.chosen }))}
                onToggle={(key, chosen) => setManual((current) => ({ ...current, [key]: chosen }))}
              />
            )}
          </div>

          <Group caption="For the books you add">
            {model.switches && (
              <>
                <Row
                  label="Get the audiobooks"
                  info={<InfoMark name="Get the audiobooks" text={tip("seriesAudio")} />}
                  control={
                    <Switch
                      label="Get the audiobooks"
                      on={model.switches.audio}
                      onChange={(on) => {
                        setGetAudio(on);
                        store(SERIES_GET_AUDIO_KEY, on);
                      }}
                    />
                  }
                />
                <Row
                  label="Get the ebooks"
                  info={<InfoMark name="Get the ebooks" text={tip("seriesEbooks")} />}
                  control={
                    <Switch
                      label="Get the ebooks"
                      on={model.switches.ebooks}
                      onChange={(on) => {
                        setGetEbooks(on);
                        store(SERIES_GET_EBOOKS_KEY, on);
                      }}
                    />
                  }
                />
              </>
            )}
            <li className="part-row-item">
              <label className="part-row series-add-language">
                <span className="part-row-label type-body">Preferred language</span>
                <span className="part-row-value type-label" aria-hidden="true">
                  {languageName(model.language)}
                  <Chevron />
                </span>
                <select
                  aria-label="Preferred language"
                  value={model.language}
                  onChange={(event) => onLanguage(event.target.value)}
                >
                  {model.languages.map((item) => (
                    <option key={item} value={item}>
                      {languageName(item)}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          </Group>
        </>
      )}
    </Sheet>
  );
}
