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

## Adding a part to the gallery

The gallery is `#gallery` (no navigation links to it), with a child page at `#gallery/child`. Add one file,
`src/gallery/sections/<part>.tsx`, that default-exports a `GallerySection` (`src/gallery/section.ts`): an `id`, a
`title`, an `order` and a `render` that shows the part in each of its states inside `Sample`s. The registry
(`src/gallery/sections.ts`) finds every file in that folder, so no other file changes. Then add the part's
measures to `tests/e2e/gallery.spec.ts`, which runs every preset and both densities in Chromium and Firefox.
