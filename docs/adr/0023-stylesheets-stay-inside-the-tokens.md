# Stylesheets stay inside the tokens

The redesign replaced twelve corner radii and no shared spacing with tokens: six spacing steps (4, 8, 12, 16, 24, 32), three corners (8, 14, round), three heights and five text styles (#480). The last slice of the redesign removes what is left of the old styles, and the plan asks for a unit test that fails when a stylesheet uses a corner or a spacing value outside the tokens, so that the language cannot drift again. This record settles what that test allows.

- **What is checked.** Every declaration in every `.css` file under `src/` whose property sets a corner (`border-radius` and its longhands) or spacing (`padding`, `margin`, `gap` and their longhands and logical forms). Heights, widths and positions (`top`, `inset`, …) are not checked: covers, icons and bars have sizes of their own, and the boards use them.
- **What is allowed.** A token variable, by the names `src/appearance.css` defines for spacing and corners (the check reads them there and keeps no copy of the values); `0`; `auto` for a margin; a CSS-wide keyword; `env(safe-area-inset-*)`; and `calc()`, `min()`, `max()` whose terms are tokens, safe-area insets, plain numbers multiplying a token, or `0`. A value written in pixels, ems or rems, or a percentage, is not allowed, even when it equals a token, because the compact density and later changes act on the variables only.
- **What counts as an exception.** A value the boards draw that no token gives: a thin bar or a pointer whose corner is smaller than 8, a corner nested inside a control's padding, a tooltip mark's widened hit area. It is written on the declaration with a comment, `/* tokens: <reason> */`, and the reason may not be empty. The test pins how many exceptions there are, so a new one is a visible change to the test in review, not a silent addition.
- **Where it runs.** A script `scripts/check-stylesheet-tokens.mjs` with a function the unit test calls, as `scripts/check-server-catches.mjs` is built. It reads the stylesheets with the file system from the source tree, never through git, so it runs in the check's snapshot.

## Considered options

- **Allow any literal value that equals a token** (`16px` as well as the variable). Refused: the compact density scales the variables, so a literal that matches today silently falls out of the density, and nothing tells a reader that the value is meant to be a token.
- **A baseline file of frozen violations**, as the server catch check keeps. Refused for this rule: the plan's "Done" is no value outside the tokens, not "no new one"; the few exceptions belong next to the declaration with their reason, where a reader of the stylesheet sees them.
- **Check heights and widths too.** Refused: the boards use many sizes that are not tokens (covers of 40, 120 and 200, icons of 20, a progress line of 2), and the plan asks for corners and spacing only.
- **Check inline styles in components.** Refused for now: no component sets a corner or spacing inline today, and a computed inline value (an indent by depth, a position from a measurement) is not a token question. A later change that adds such styles can extend the check.

## Consequences

- The text of the book in the reader is not a stylesheet of the app: its margins, line height and size come from the reader's settings and are laid into the EPUB's frame by the reader, outside the check.
- A new part or page is written with the token variables from its first line; the test fails on its pull request otherwise.
- Changing a token's value changes every screen at once, which is the point; adding a fourth corner or a seventh spacing step is a change to `src/appearance.css`, to the boards and to this record.
