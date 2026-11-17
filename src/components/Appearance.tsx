import { userId, userStorageKey } from "../lib";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib";
import {
  appearanceSchema,
  appearanceToSave,
  cachedAppearance,
  applyAppearance,
  type Appearance,
} from "../appearance";
type ThemeContext = {
  /** What is shown, including an unsaved preview. */
  appearance: Appearance;
  /** Last stored appearance. */
  saved: Appearance;
  /** Previews a value without storing it. */
  update: (value: Appearance) => void;
  save: (value?: Appearance, deviceOnly?: boolean) => Promise<void>;
  /** Stores reader settings on top of the saved appearance; a preview stays unsaved. */
  saveReader: (patch: Partial<Appearance["reader"]>) => Promise<void>;
  /** Stores playback settings on top of the saved appearance; a preview stays unsaved. */
  savePlayback: (patch?: Partial<Appearance["playback"]>) => Promise<void>;
};
const Context = createContext<ThemeContext>(null!);
export const useAppearance = () => useContext(Context);
const deviceOnlySetting = () =>
  localStorage.getItem(userStorageKey("sonder-appearance-device")) === "true";
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState(cachedAppearance);
  const [saved, setSaved] = useState(cachedAppearance);
  const shown = useRef(appearance),
    stored = useRef(saved);
  const update = (value: Appearance) => {
    const parsed = appearanceSchema.parse(value);
    shown.current = parsed;
    setAppearance(parsed);
    applyAppearance(parsed);
  };
  const remember = (value: Appearance) => {
    const parsed = appearanceSchema.parse(value);
    stored.current = parsed;
    setSaved(parsed);
    localStorage.setItem(userStorageKey("sonder-appearance"), JSON.stringify(parsed));
    return parsed;
  };
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => applyAppearance(cachedAppearance());
    media.addEventListener("change", change);
    // Until /auth/status names the user, only show the cached look: storage
    // keys still point at the admin.
    applyAppearance(shown.current);
    const load = () => {
      const cached = cachedAppearance();
      stored.current = cached;
      setSaved(cached);
      update(cached);
      if (deviceOnlySetting()) return;
      const owner = userId();
      void api<Appearance>("/appearance")
        .then((value) => {
          if (owner !== userId()) return;
          update(remember(value));
        })
        .catch(() => {});
    };
    window.addEventListener("sonder:authenticated", load);
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("sonder:authenticated", load);
    };
  }, []);
  // Settings saves each change at once, so a stepper tapped twice sends two saves: they go out one after the other,
  // so the server keeps the last one.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const put = (value: Appearance) => {
    const next = queue.current.catch(() => {}).then(() =>
      api("/appearance", {
        method: "PUT",
        body: JSON.stringify(appearanceToSave(value)),
      }),
    );
    queue.current = next;
    return next;
  };
  const save = async (value = appearance, deviceOnly = deviceOnlySetting()) => {
    update(remember(value));
    if (!deviceOnly) await put(value);
    localStorage.setItem(userStorageKey("sonder-appearance-device"), String(deviceOnly));
  };
  const saveReader = async (patch: Partial<Appearance["reader"]>) => {
    const reader = { ...shown.current.reader, ...patch };
    update({ ...shown.current, reader });
    const value = remember({ ...stored.current, reader });
    if (!deviceOnlySetting()) await put(value);
  };
  const savePlayback = async (patch: Partial<Appearance["playback"]> = {}) => {
    const playback = { ...shown.current.playback, ...patch };
    update({ ...shown.current, playback });
    const value = remember({ ...stored.current, playback });
    if (!deviceOnlySetting()) await put(value);
  };
  return (
    <Context.Provider
      value={{ appearance, saved, update, save, saveReader, savePlayback }}
    >
      {children}
    </Context.Provider>
  );
}
