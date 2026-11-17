# Shared parts

The redesign's parts (spec #480, "Parts"; boards in `docs/design/redesign/project/`, `Main.dc.html` first). Old
screens do not use them yet; each screen's slice moves it over.

- **Tokens:** `tokens.css` (custom properties `--space-4` … `--space-32`, `--corner-control|group|round`,
  `--height-control|row|bar`, `--edge`, and the classes `.type-title|heading|body|label|caption`) and
  `tokens.ts` (the same numbers). `tests/parts-tokens.test.ts` keeps them equal to the spec. Colours are the
  existing variables of `src/appearance.css` (`--background`, `--surface`, `--raised`, `--border`, `--text`,
  `--muted`, `--accent`, `--on-accent`); a part never names a colour of its own, so every preset and the custom
  palette apply. The compact density changes nothing in a part's measures.
- **One file per part**, with its own stylesheet beside it (`Row.tsx` + `row.css`), class names `part-<name>`.
  Import parts from their own file; there is no index to edit.
- **Every part** has a name and a role, is reached with Tab when it does something, and is at least 44 by 44 where
  it is tapped.

- **Tooltip** (`Tooltip.tsx`, on `@radix-ui/react-popover`): `InfoMark` is the circled i after a name; pass it as
  `info` to a `Row` that shows a value or a control, to a `Group` with a caption, or to a `PageHeader`. One
  explanation is open at a time; it opens on a tap, and on a desktop on keyboard focus and on hover once the pointer
  rests on the mark for `HOVER_OPEN_MS` (a pointer passing over marks opens none). A hover's explanation closes when
  the pointer leaves the mark, the explanation and the gap between them. It is never in the address. `IconName` wraps an icon-only `Button` so it shows its name on hover. Measured by
  `tests/e2e/gallery-tooltip.spec.ts`.

## Adding a part to the gallery

The gallery is `#gallery` (no navigation links to it), with a child page at `#gallery/child`. Add one file,
`src/gallery/sections/<part>.tsx`, that default-exports a `GallerySection` (`src/gallery/section.ts`): an `id`, a
`title`, an `order` and a `render` that shows the part in each of its states inside `Sample`s. The registry
(`src/gallery/sections.ts`) finds every file in that folder, so no other file changes. Then add the part's
measures to `tests/e2e/gallery.spec.ts`, which runs every preset and both densities in Chromium and Firefox.
