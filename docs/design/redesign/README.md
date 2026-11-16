# Sonder redesign boards

The design of the interface and settings redesign: 40 boards on the owner's canvas. `HANDOFF.md` is the full handoff (brief, decisions, board list); the plan is `docs/REDESIGN_PLAN.md`.

**The canvas is where the owner reviews and comments** (URL in `HANDOFF.md`, "Where it is"). The files here are the source for what is published there.

## Where things are

- `project/`: the 40 boards (`*.dc.html`) and `canvas.json` (layout and titles). These files are the source of truth: edit a board directly.
- `tools/check-boards.mjs`: renders every board in Chromium and reports clipped, cut-off or malformed content.
- `tools/build.mjs`, `lib.mjs`, `tips.mjs`: how the later-round boards were first written. `tips.mjs` holds every tooltip text. Do not rebuild a board that was edited by hand.
- Not copied: the review pages (`preview/`), the first-draft copy (`published-v9/`) and build output. The check writes to `tools/out/` (git-ignored).

## Check the boards

```bash
node docs/design/redesign/tools/check-boards.mjs                    # all boards
node docs/design/redesign/tools/check-boards.mjs Library.dc.html    # one board
node docs/design/redesign/tools/check-boards.mjs --pages            # also writes review pages to tools/out/preview
```

Uses the repository's Playwright. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if the default Chromium path is missing. An ellipsis on a long title and the Library chip row running off the edge are reported on purpose. Screenshots go to `tools/out/shots/`.

## Build

```bash
SONDER_DESIGN_SRC=<folder with the first-draft boards> node docs/design/redesign/tools/build.mjs
```

Writes to `tools/out/project/`, never to `project/`. `SONDER_DESIGN_SRC` is required because `published-v9/` is not in the repository (it defaults to `../published-v9/project`). Copy a built board into `project/` only for a new board.

## Publish to the canvas

Only an interactive Claude Code session has the canvas tool (`Artifact`); an Orca chat or `claude -p` does not. See "Publishing a change" in `HANDOFF.md`:

1. Start or reuse an interactive session; give it the canvas URL, a root folder that holds `project/`, and the files to send. It updates that canvas, never creates a new one.
2. It reads `project/canvas.json` from the canvas first and keeps anything the owner moved or renamed.
3. It sends the changed boards, then `canvas.json` last, only if the layout changed.
4. Compare with the canvas before sending when it holds a version you did not publish: a hand edit by the owner is not protected by a refusal.
