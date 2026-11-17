// Settings › Appearance (board SettingsAppearance.dc.html): the app's look and the reader's, each saved when it is
// changed, through the same appearance the reader's Appearance panel writes (src/appearance.ts). Nothing new is
// stored: a colour field saves when the pointer rests, the rest at once.
import { useEffect, useRef } from "react";
import { useAppearance } from "../../components/Appearance";
import { contrast, paletteFor, type Appearance } from "../../appearance";
import { Group } from "../../parts/Group";
import { Row } from "../../parts/Row";
import { Segmented } from "../../parts/Segmented";
import { Stepper } from "../../parts/Stepper";
import { InfoMark } from "../../parts/Tooltip";
import { tip } from "../../tooltip-texts";
import { PRESET_NAMES, themeName } from "../../settings-list";
import { ChoiceRow } from "./Choice";
import { StackedRow } from "./StackedRow";

type Notify = (text: string, error?: boolean) => void;
type Theme = Appearance["preset"] | "custom";

const THEMES: { value: Theme; label: string }[] = [
  ...(Object.entries(PRESET_NAMES) as [Appearance["preset"], string][]).map(([value, label]) => ({ value, label })),
  { value: "custom", label: "Custom colours" },
];
/** The board's four accents; any other colour is the custom one. */
export const ACCENTS = [
  { name: "Orange", color: "#dd8966" },
  { name: "Amber", color: "#e0b060" },
  { name: "Sage", color: "#8fb8a0" },
  { name: "Blue", color: "#9db4e8" },
] as const;
const FONTS = [
  { value: "sans", label: "DM Sans" },
  { value: "system", label: "System" },
  { value: "serif", label: "Serif" },
] as const;
const READER_THEMES = [
  { value: "app", label: "App" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "sepia", label: "Sepia" },
] as const;
const READER_FONTS = [
  { value: "serif", label: "Serif" },
  { value: "sans", label: "Sans serif" },
  { value: "system", label: "System" },
] as const;
const COLOUR_FIELDS = [
  ["background", "Page"],
  ["surface", "Surfaces"],
  ["text", "Main text"],
  ["muted", "Secondary text"],
  ["border", "Borders"],
] as const;
const COLOUR_WAIT_MS = 400;

function Swatch({ name, color, chosen, onChoose }: { name: string; color: string; chosen: boolean; onChoose: () => void }) {
  return (
    <button type="button" className="settings-swatch" aria-label={name} aria-pressed={chosen} onClick={onChoose}>
      <span style={{ background: color }} data-chosen={chosen ? "" : undefined} />
    </button>
  );
}

export function AppearancePage({ notify }: { notify: Notify }) {
  const { appearance, update, save, saveReader } = useAppearance();
  const failed = (error: Error) => notify(error.message, true);
  const store = (patch: Partial<Appearance>) => void save({ ...appearance, ...patch }).catch(failed);
  // A colour field reports every step of a drag: it is shown at once and saved once the pointer rests.
  const colourTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Appearance | null>(null);
  useEffect(
    () => () => {
      if (colourTimer.current) clearTimeout(colourTimer.current);
      if (pending.current) void save(pending.current).catch(() => {});
    },
    [],
  );
  const storeSoon = (value: Appearance) => {
    update(value);
    pending.current = value;
    if (colourTimer.current) clearTimeout(colourTimer.current);
    colourTimer.current = setTimeout(() => {
      colourTimer.current = null;
      const next = pending.current;
      pending.current = null;
      if (next) void save(next).catch(failed);
    }, COLOUR_WAIT_MS);
  };
  const palette = paletteFor(appearance);
  const custom = themeName(appearance) === "Custom colours";
  const accentKnown = ACCENTS.some((accent) => accent.color === appearance.accent.toLowerCase());
  const ratio = contrast(palette.text, palette.background);
  const mutedRatio = contrast(palette.muted, palette.background);
  return (
    <>
      <Group caption="App">
        <ChoiceRow<Theme>
          name="Theme"
          options={THEMES}
          value={custom ? "custom" : appearance.preset}
          onChange={(theme) =>
            theme === "custom"
              ? // Custom colours start from the colours shown, so nothing changes until a field does.
                store({ colors: Object.fromEntries(COLOUR_FIELDS.map(([key]) => [key, palette[key]])) })
              : store({ preset: theme, colors: {} })
          }
        />
        <Row
          label="Accent"
          control={
            <span className="settings-swatches" role="group" aria-label="Accent">
              {ACCENTS.map((accent) => (
                <Swatch key={accent.color} name={accent.name} color={accent.color} chosen={appearance.accent.toLowerCase() === accent.color} onChoose={() => store({ accent: accent.color })} />
              ))}
              <label className="settings-swatch settings-swatch-custom" data-chosen={accentKnown ? undefined : ""}>
                <input type="color" aria-label="Custom accent" value={appearance.accent} onChange={(event) => storeSoon({ ...appearance, accent: event.target.value })} />
              </label>
            </span>
          }
        />
        <ChoiceRow name="Font" options={FONTS} value={appearance.font} onChange={(font) => store({ font })} />
        <Row
          label="Text size"
          control={
            <Stepper
              label="Text size"
              value={appearance.scale}
              min={0.9}
              max={1.6}
              step={0.05}
              format={(value) => `${Math.round(value * 100)}%`}
              decreaseLabel="Smaller text"
              increaseLabel="Larger text"
              onChange={(scale) => store({ scale })}
            />
          }
        />
        <StackedRow label="Density" info={<InfoMark name="Density" text={tip("density")} />}>
          <Segmented
            label="Density"
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
            value={appearance.density}
            onChange={(density) => store({ density })}
          />
        </StackedRow>
      </Group>
      {custom && (
        <Group caption="Custom colours" note={`Text contrast ${ratio.toFixed(1)}:1 · Secondary text ${mutedRatio.toFixed(1)}:1. Aim for at least 4.5:1.`}>
          {COLOUR_FIELDS.map(([key, label]) => (
            <Row
              key={key}
              label={label}
              control={
                <input
                  className="settings-colour"
                  type="color"
                  aria-label={label}
                  value={palette[key]}
                  onChange={(event) => storeSoon({ ...appearance, colors: { ...appearance.colors, [key]: event.target.value } })}
                />
              }
            />
          ))}
        </Group>
      )}
      <Group caption="Reader">
        <ChoiceRow
          name="Theme"
          title="Reader theme"
          info={<InfoMark name="Reader theme" text={tip("readerTheme")} />}
          options={READER_THEMES}
          value={appearance.reader.theme}
          onChange={(theme) => void saveReader({ theme }).catch(failed)}
        />
        <ChoiceRow name="Font" title="Reader font" options={READER_FONTS} value={appearance.reader.font} onChange={(font) => void saveReader({ font }).catch(failed)} />
        <Row
          label="Size"
          control={
            <Stepper
              label="Book text size"
              value={appearance.reader.size}
              min={14}
              max={36}
              step={1}
              decreaseLabel="Smaller book text"
              increaseLabel="Larger book text"
              onChange={(size) => void saveReader({ size }).catch(failed)}
            />
          }
        />
      </Group>
    </>
  );
}
