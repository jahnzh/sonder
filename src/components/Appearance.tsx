import { userStorageKey } from "../lib";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Palette, RotateCcw, Download, Upload, Check } from "lucide-react";
import { api } from "../lib";
import {
  appearanceSchema,
  defaultAppearance,
  cachedAppearance,
  applyAppearance,
  paletteFor,
  contrast,
  type Appearance,
} from "../appearance";
type ThemeContext = {
  appearance: Appearance;
  update: (value: Appearance) => void;
  save: (value?: Appearance, deviceOnly?: boolean) => Promise<void>;
};
const Context = createContext<ThemeContext>(null!);
export const useAppearance = () => useContext(Context);
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState(cachedAppearance);
  const update = (value: Appearance) => {
    const parsed = appearanceSchema.parse(value);
    setAppearance(parsed);
    applyAppearance(parsed);
    localStorage.setItem(userStorageKey("sonder-appearance"), JSON.stringify(parsed));
  };
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => applyAppearance(cachedAppearance());
    media.addEventListener("change", change);
    const load = () => {
      update(cachedAppearance());
      if (localStorage.getItem(userStorageKey("sonder-appearance-device")) !== "true")
        void api<Appearance>("/appearance")
          .then(update)
          .catch(() => {});
    };
    load();
    window.addEventListener("sonder:authenticated", load);
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("sonder:authenticated", load);
    };
  }, []);
  const save = async (
    value = appearance,
    deviceOnly = localStorage.getItem(userStorageKey("sonder-appearance-device")) === "true",
  ) => {
    update(value);
    if (!deviceOnly)
      await api("/appearance", { method: "PUT", body: JSON.stringify(value) });
    localStorage.setItem(userStorageKey("sonder-appearance-device"), String(deviceOnly));
  };
  return (
    <Context.Provider value={{ appearance, update, save }}>
      {children}
    </Context.Provider>
  );
}
export function AppearanceSettings({
  notify,
}: {
  notify: (text: string, error?: boolean) => void;
}) {
  const { appearance, update, save } = useAppearance();
  const [deviceOnly, setDeviceOnly] = useState(
    localStorage.getItem(userStorageKey("sonder-appearance-device")) === "true",
  );
  const [saved, setSaved] = useState(appearance);
  const [busy, setBusy] = useState(false);
  const palette = paletteFor(appearance),
    ratio = contrast(palette.text, palette.background),
    mutedRatio = contrast(palette.muted, palette.background);
  const edit = (patch: Partial<Appearance>) =>
    update({ ...appearance, ...patch });
  return (
    <section
      className="appearance-settings settings-section"
      aria-label="Appearance"
    >
      <div className="settings-section-heading">
        <span className="settings-section-icon">
          <Palette size={20} />
        </span>
        <div>
          <h2>Appearance</h2>
          <p>Preview changes before saving.</p>
        </div>
      </div>
      <div className="theme-presets" role="group" aria-label="Theme presets">
        {(
          [
            ["forest", "Forest"],
            ["charcoal", "Charcoal"],
            ["amoled", "AMOLED"],
            ["contrast", "High contrast"],
            ["light", "Light"],
            ["system", "System"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={appearance.preset === id}
            onClick={() => edit({ preset: id, colors: {} })}
            className={appearance.preset === id ? "selected" : ""}
          >
            {label}
            {appearance.preset === id && <Check size={14} />}
          </button>
        ))}
      </div>
      <div className="appearance-grid">
        <label>
          Accent color
          <input
            aria-label="Accent color"
            type="color"
            value={appearance.accent}
            onChange={(event) => edit({ accent: event.target.value })}
          />
        </label>
        <label>
          Interface font
          <select
            value={appearance.font}
            onChange={(event) =>
              edit({ font: event.target.value as Appearance["font"] })
            }
          >
            <option value="sans">Sonder sans</option>
            <option value="system">System font</option>
            <option value="serif">Serif</option>
          </select>
        </label>
        <label>
          Text size · {Math.round(appearance.scale * 100)}%
          <input
            aria-label="Interface text size"
            type="range"
            min="0.9"
            max="1.6"
            step="0.05"
            value={appearance.scale}
            onChange={(event) => edit({ scale: Number(event.target.value) })}
          />
        </label>
        <label>
          Spacing
          <select
            aria-label="Interface spacing"
            value={appearance.density}
            onChange={(event) =>
              edit({ density: event.target.value as Appearance["density"] })
            }
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
      </div>
      <details className="appearance-advanced">
        <summary>Custom palette</summary>
        <div className="appearance-grid">
          {(["background", "surface", "text", "muted", "border"] as const).map(
            (key) => (
              <label key={key}>
                {
                  {
                    background: "Page",
                    surface: "Surfaces",
                    text: "Main text",
                    muted: "Secondary text",
                    border: "Borders",
                  }[key]
                }
                <input
                  aria-label={`Custom ${key} color`}
                  type="color"
                  value={palette[key]}
                  onChange={(event) =>
                    edit({
                      colors: {
                        ...appearance.colors,
                        [key]: event.target.value,
                      },
                    })
                  }
                />
              </label>
            ),
          )}
        </div>
        <p
          className={
            ratio < 4.5 || mutedRatio < 4.5 ? "appearance-warning" : "muted"
          }
        >
          Text contrast {ratio.toFixed(1)}:1 · Secondary text{" "}
          {mutedRatio.toFixed(1)}:1. Aim for at least 4.5:1.
        </p>
      </details>
      <label className="appearance-device">
        <input
          type="checkbox"
          checked={deviceOnly}
          onChange={(event) => setDeviceOnly(event.target.checked)}
        />{" "}
        Use these settings only on this device
      </label>
      <div className="appearance-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void save(appearance, deviceOnly)
              .then(() => {
                setSaved(appearance);
                notify("Appearance saved.");
              })
              .catch((error) => notify(error.message, true))
              .finally(() => setBusy(false));
          }}
        >
          Save appearance
        </button>
        <button
          type="button"
          className="button subtle"
          onClick={() => update(saved)}
        >
          Undo preview
        </button>
        <button
          type="button"
          className="button subtle"
          onClick={() => update(defaultAppearance)}
        >
          <RotateCcw size={14} /> Reset
        </button>
        <button
          type="button"
          className="button subtle"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(appearance, null, 2)], {
                type: "application/json",
              }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "sonder-appearance.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={14} /> Export
        </button>
        <label className="button subtle appearance-import">
          <Upload size={14} /> Import
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Import appearance preset"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > 20000) {
                notify("Choose a preset smaller than 20 KB.", true);
                return;
              }
              void file
                .text()
                .then((text) => {
                  update(appearanceSchema.parse(JSON.parse(text)));
                  notify("Preset loaded. Save to keep it.");
                })
                .catch(() =>
                  notify("This is not a valid Sonder appearance preset.", true),
                );
            }}
          />
        </label>
      </div>
    </section>
  );
}
