// Appearance docked under the text (#588; spec #586 "Appearance docked under the text"; board
// ReaderAppearance.dc.html). The reader's Aa docks this panel in the dock row, in place of the foot: the text band is
// what is left between the head and the panel, and the reader lays the text out again there with the narrated
// sentence in view. Rows in the board's order: Reading mode (first: it is the setting used most), Follow the
// narration, Theme, Font, Size, Line height, then Margins and Line width (not drawn on the board; kept because the
// plan removes only the view and its two settings). Each change is saved as before (`saveReader`, appearance.ts).
// The panel is not in the address: Back with it open leaves the reader.
import { useRef, type KeyboardEvent } from "react";
import type { Appearance } from "../appearance";
import { Row } from "../parts/Row";
import { Segmented } from "../parts/Segmented";
import { Stepper } from "../parts/Stepper";
import { Switch } from "../parts/Switch";
import { InfoMark } from "../parts/Tooltip";
import { segmentForKey } from "../parts/segment-keys";
import { tip } from "../tooltip-texts";
import "./reader-appearance.css";

type ReaderPreferences = Appearance["reader"];
type Theme = ReaderPreferences["theme"];

/** The rows' names, in the board's order. */
export const APPEARANCE_ROWS = ["Reading mode", "Follow the narration", "Theme", "Font", "Size", "Line height", "Margins", "Line width"] as const;

// The swatches show the page each theme gives the book (Reader.tsx's themes); App is the app's own ground.
const THEMES: { value: Theme; label: string; swatch: string }[] = [
  { value: "app", label: "App", swatch: "var(--background)" },
  { value: "dark", label: "Dark", swatch: "#101510" },
  { value: "light", label: "Light", swatch: "#ffffff" },
  { value: "sepia", label: "Sepia", swatch: "#f2e6cd" },
];

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

/** Theme as swatches (the board): a radio group, as the Segmented control is, so the arrows choose. */
function ThemeSwatches({ value, onChange }: { value: Theme; onChange: (value: Theme) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = THEMES.findIndex((theme) => theme.value === value);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = segmentForKey(event.key, index, THEMES.map(() => true));
    if (next === null) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    if (THEMES[next].value !== value) onChange(THEMES[next].value);
  };
  return (
    <span className="reader-appearance-swatches" role="radiogroup" aria-label="Theme">
      {THEMES.map((theme, index) => (
        <button
          key={theme.value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={index === chosen}
          aria-label={theme.label}
          tabIndex={index === (chosen >= 0 ? chosen : 0) ? 0 : -1}
          className="reader-appearance-swatch"
          data-chosen={index === chosen ? "" : undefined}
          onClick={() => {
            if (theme.value !== value) onChange(theme.value);
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          <span style={{ background: theme.swatch }} />
        </button>
      ))}
    </span>
  );
}

export type ReaderAppearanceProps = {
  preferences: ReaderPreferences;
  /** Saves a change of the reader's settings (`saveReader`). */
  onChange: (patch: Partial<ReaderPreferences>) => void;
  /** Following the narration: on, the narrated sentence is kept in view and highlighted. */
  follow: boolean;
  onFollow: (on: boolean) => void;
  /** The Theme row: the reader inside Now playing always takes the app's look, so it has none there. */
  theme?: boolean;
  onClose: () => void;
};

export function ReaderAppearance({ preferences, onChange, follow, onFollow, theme = true, onClose }: ReaderAppearanceProps) {
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
        {theme && <Row label="Theme" control={<ThemeSwatches value={preferences.theme} onChange={(value) => onChange({ theme: value })} />} />}
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
