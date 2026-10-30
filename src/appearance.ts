import { z } from "zod";
const hex = z.string().regex(/^#[a-f\d]{6}$/i);
export const appearanceSchema = z.object({
  version: z.literal(1).default(1),
  preset: z
    .enum(["forest", "charcoal", "amoled", "contrast", "light", "system"])
    .default("forest"),
  accent: hex.default("#dd8966"),
  font: z.enum(["sans", "system", "serif"]).default("sans"),
  scale: z.number().min(0.9).max(1.6).default(1),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  playback: z
    .object({
      progressScope: z.enum(["book", "chapter"]).default("book"),
      // Unset until chosen in Settings, so the older device-wide speed still applies.
      // null is a cleared default; a missing field comes from a client that predates it.
      speed: z.number().min(0.5).max(3).nullable().optional(),
    })
    .default({ progressScope: "book" }),
  colors: z
    .object({
      background: hex.optional(),
      surface: hex.optional(),
      text: hex.optional(),
      muted: hex.optional(),
      border: hex.optional(),
    })
    .default({}),
  reader: z
    .object({
      theme: z.enum(["dark", "light", "sepia", "app"]).default("app"),
      font: z.enum(["serif", "sans", "system"]).default("serif"),
      size: z.number().min(14).max(36).default(19),
      lineHeight: z.number().min(1.2).max(2.4).default(1.7),
      margin: z.number().min(8).max(80).default(20),
      width: z.number().min(350).max(1100).default(720),
      mode: z.enum(["paginated", "scroll"]).default("paginated"),
      display: z.enum(["book", "segment", "word"]).default("book"),
      segmentWords: z.number().int().min(1).max(160).default(30),
      wordWpm: z.number().int().min(100).max(900).default(300),
    })
    .default({
      theme: "app",
      font: "serif",
      size: 19,
      lineHeight: 1.7,
      margin: 20,
      width: 720,
      mode: "paginated",
      display: "book",
      segmentWords: 30,
      wordWpm: 300,
    }),
});
export type Appearance = z.infer<typeof appearanceSchema>;
export const defaultAppearance = appearanceSchema.parse({});
/** Older clients drop `playback.speed` when they save; that must not clear it. */
export function keepPlaybackSpeed(input: Appearance, stored: Appearance): Appearance {
  return input.playback.speed === undefined && stored.playback.speed !== undefined
    ? { ...input, playback: { ...input.playback, speed: stored.playback.speed } }
    : input;
}
/**
 * Older clients drop `reader.wordWpm` when they save; a body without it must
 * not reset the stored words per minute to the default. `sent` is the body as
 * received, since parsing fills in the default.
 */
export function keepWordWpm(input: Appearance, stored: Appearance, sent: unknown): Appearance {
  const reader = (sent as { reader?: { wordWpm?: unknown } } | null)?.reader;
  return reader?.wordWpm === undefined
    ? { ...input, reader: { ...input.reader, wordWpm: stored.reader.wordWpm } }
    : input;
}
/** What this client sends: an unset default speed goes out as null, so the server clears it too. */
export function appearanceToSave(value: Appearance): Appearance {
  return {
    ...value,
    playback: { ...value.playback, speed: value.playback.speed ?? null },
  };
}
export const palettes = {
  forest: {
    background: "#101510",
    surface: "#182117",
    raised: "#26331f",
    text: "#e6eadf",
    muted: "#a9b59d",
    border: "#3c4934",
  },
  charcoal: {
    background: "#15171c",
    surface: "#1e222a",
    raised: "#2c3340",
    text: "#eef0f6",
    muted: "#b0b8c8",
    border: "#404959",
  },
  amoled: {
    background: "#000000",
    surface: "#101010",
    raised: "#202020",
    text: "#f4f4f4",
    muted: "#b5b5b5",
    border: "#414141",
  },
  contrast: {
    background: "#080808",
    surface: "#141414",
    raised: "#292929",
    text: "#ffffff",
    muted: "#dedede",
    border: "#b6b6b6",
  },
  light: {
    background: "#f5f4f0",
    surface: "#ffffff",
    raised: "#e7e6df",
    text: "#202820",
    muted: "#52604f",
    border: "#b9c0b3",
  },
};
export function luminance(color: string) {
  const channels = color
    .match(/[a-f\d]{2}/gi)!
    .map((value) => parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function paletteFor(appearance: Appearance, dark = true) {
  return {
    ...palettes[
      appearance.preset === "system"
        ? dark
          ? "forest"
          : "light"
        : appearance.preset
    ],
    ...appearance.colors,
  };
}
export const fontFamilies = {
  sans: '"DM Sans Variable", sans-serif',
  system: "system-ui, sans-serif",
  serif: 'Georgia, "Times New Roman", serif',
};
export function applyAppearance(value: Appearance) {
  const root = document.documentElement,
    palette = paletteFor(
      value,
      matchMedia("(prefers-color-scheme: dark)").matches,
    );
  root.dataset.theme = value.preset;
  root.dataset.density = value.density;
  for (const [key, color] of Object.entries(palette))
    root.style.setProperty(`--${key}`, color);
  root.style.setProperty("--accent", value.accent);
  root.style.setProperty(
    "--on-accent",
    // Dark text on accent is a near-black tint of the accent rather than pure black.
    contrast(value.accent, "#000000") >= contrast(value.accent, "#ffffff")
      ? `color-mix(in srgb, ${value.accent} 12%, #000)`
      : "#ffffff",
  );
  root.style.setProperty(
    "--danger",
    luminance(palette.background) > 0.3 ? "#9a3128" : "#f4a590",
  );
  root.style.setProperty("--ui-scale", String(value.scale));
  root.style.setProperty("--font-body", fontFamilies[value.font]);
  root.style.setProperty(
    "--font-heading",
    value.font === "sans"
      ? '"Manrope Variable", sans-serif'
      : fontFamilies[value.font],
  );
  root.style.colorScheme =
    luminance(palette.background) > 0.3 ? "light" : "dark";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", palette.surface);
}
export function cachedAppearance() {
  try {
    return appearanceSchema.parse(
      JSON.parse(localStorage.getItem(sessionStorage.getItem("sonder-current-user") && sessionStorage.getItem("sonder-current-user") !== "1" ? `sonder-user-${sessionStorage.getItem("sonder-current-user")}:sonder-appearance` : "sonder-appearance") || "{}"),
    );
  } catch {
    return defaultAppearance;
  }
}
