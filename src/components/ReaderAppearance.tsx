// Appearance docked under the text (#588; spec #586 "Appearance docked under the text"; board
// ReaderAppearance.dc.html). The reader's Aa docks this panel in the dock row, in place of the foot: the text band is
// what is left between the head and the panel, and the reader lays the text out again there with the narrated
// sentence in view. Rows in the board's order: Reading mode (first: it is the setting used most), Follow the
// narration, Font, Size, Line height, then Margins and Line width (not drawn on the board; kept because the
// plan removes only the view and its two settings). The board's Theme row went with the reader on its own, the
// only reader that had it (#613 part 2): the text takes the app's look. Each change is saved as before (`saveReader`, appearance.ts).
// A reader with the text position rail (#804) lists Reading position after Follow the narration: the whole book or the chapter.
// The panel is not in the address: Back with it open leaves the reader.
import type { Appearance } from "../appearance";
import { Row } from "../parts/Row";
import { Segmented } from "../parts/Segmented";
import { Stepper } from "../parts/Stepper";
import { Switch } from "../parts/Switch";
import { InfoMark } from "../parts/Tooltip";
import { tip } from "../tooltip-texts";
import "./reader-appearance.css";

type ReaderPreferences = Appearance["reader"];

/** The rows' names, in the board's order. */
export const APPEARANCE_ROWS = ["Reading mode", "Follow the narration", "Font", "Size", "Line height", "Margins", "Line width"] as const;

// The ranges the stored appearance allows (appearance.ts), in the steps the old sliders used.
const STEPPERS = [
  { key: "size", label: "Size", min: 14, max: 36, step: 1 },
  { key: "lineHeight", label: "Line height", min: 1.2, max: 2.4, step: 0.1 },
  { key: "margin", label: "Margins", min: 8, max: 80, step: 2 },
  { key: "width", label: "Line width", min: 350, max: 1100, step: 25 },
] as const;

function Close() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export type ReaderAppearanceProps = {
  preferences: ReaderPreferences;
  /** Saves a change of the reader's settings (`saveReader`). */
  onChange: (patch: Partial<ReaderPreferences>) => void;
  /** Following the narration: on, the narrated sentence is kept in view and highlighted. */
  follow: boolean;
  onFollow: (on: boolean) => void;
  /** The reader has the text position rail (the new reading view): the row that says what it shows is listed. */
  rail?: boolean;
  onClose: () => void;
};

export function ReaderAppearance({ preferences, onChange, follow, onFollow, rail, onClose }: ReaderAppearanceProps) {
  return (
    <section className="reader-appearance-dock" aria-label="Reader appearance">
      <div className="reader-appearance-heading">
        <h2 className="type-caption">Reader appearance</h2>
        <button type="button" className="reader-appearance-close" aria-label="Close appearance" onClick={onClose}>
          <Close />
        </button>
      </div>
      <ul className="reader-appearance-rows" role="list" aria-label="Reader appearance">
        <Row
          label="Reading mode"
          info={<InfoMark name="Reading mode" text={tip("readingMode")} />}
          control={
            <span className="reader-appearance-mode">
              <Segmented
                label="Reading mode"
                options={[
                  { value: "paginated", label: "Pages" },
                  { value: "scroll", label: "Scroll" },
                ]}
                value={preferences.mode}
                onChange={(mode) => onChange({ mode })}
              />
            </span>
          }
        />
        <Row
          label="Follow the narration"
          info={<InfoMark name="Follow the narration" text={tip("follow")} />}
          control={<Switch label="Follow the narration" on={follow} onChange={onFollow} />}
        />
        {rail && (
          <Row
            label="Reading position"
            control={
              <span className="reader-appearance-mode">
                <Segmented
                  label="Reading position shows"
                  options={[
                    { value: "book", label: "Book" },
                    { value: "chapter", label: "Chapter" },
                  ]}
                  value={preferences.positionScope}
                  onChange={(positionScope) => onChange({ positionScope })}
                />
              </span>
            }
          />
        )}
        <Row
          label="Font"
          control={
            <span className="reader-appearance-font">
              <Segmented
                label="Font"
                options={[
                  { value: "serif", label: "Serif" },
                  { value: "sans", label: "Sans" },
                  { value: "system", label: "System" },
                ]}
                value={preferences.font}
                onChange={(font) => onChange({ font })}
              />
            </span>
          }
        />
        {STEPPERS.map(({ key, label, min, max, step }) => (
          <Row
            key={key}
            label={label}
            control={
              <Stepper
                label={label}
                min={min}
                max={max}
                step={step}
                value={preferences[key]}
                format={step < 1 ? (value) => value.toFixed(1) : String}
                decreaseLabel={`Less ${label.toLowerCase()}`}
                increaseLabel={`More ${label.toLowerCase()}`}
                onChange={(value) => onChange({ [key]: value })}
              />
            }
          />
        ))}
      </ul>
    </section>
  );
}
