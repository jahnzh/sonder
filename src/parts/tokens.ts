// The redesign's tokens (spec #480, "Tokens"; board docs/design/redesign/project/Main.dc.html). tokens.css holds
// the same values as CSS custom properties; tests/parts-tokens.test.ts keeps the two equal. Colours are not here:
// the existing variables (--background, --surface, --raised, --border, --text, --muted, --accent) stay the single
// source for every preset and the custom palette.

/** Six spacing steps, in px. Every gap and padding of a part is one of these. */
export const space = [4, 8, 12, 16, 24, 32] as const;

/** Three corners: 8 for controls and covers, 14 for group cards and sheets, round for chips, play and switches. */
export const corner = { control: 8, group: 14, round: 999 } as const;

/** Three heights, in px: a control, a row, a bar (mini player, tab bar). */
export const height = { control: 44, row: 52, bar: 64 } as const;

/** Screen edge in px: 16 on a phone, 32 from the desktop layout's width on. */
export const edge = { phone: 16, desktop: 32, desktopFrom: 760 } as const;

export type TextStyle = {
  /** Which family variable the style uses: the heading face (Manrope) or the body face (DM Sans). */
  family: "heading" | "body";
  weight: number;
  size: number;
  lineHeight: number;
  uppercase: boolean;
  /** Letter spacing in em. */
  tracking: number;
};

/** Five text styles. Title is one per page. */
export const text = {
  title: { family: "heading", weight: 700, size: 28, lineHeight: 34, uppercase: false, tracking: 0 },
  heading: { family: "heading", weight: 700, size: 20, lineHeight: 26, uppercase: false, tracking: 0 },
  body: { family: "body", weight: 400, size: 16, lineHeight: 22, uppercase: false, tracking: 0 },
  label: { family: "body", weight: 500, size: 14, lineHeight: 20, uppercase: false, tracking: 0 },
  caption: { family: "body", weight: 600, size: 12, lineHeight: 16, uppercase: true, tracking: 0.08 },
} as const satisfies Record<string, TextStyle>;

export type TextStyleName = keyof typeof text;
