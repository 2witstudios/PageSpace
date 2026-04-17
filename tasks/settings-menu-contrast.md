# Settings Menu Contrast Epic

**Status**: 📋 PLANNED
**Goal**: Bring the Personal settings menu rows up to WCAG AA contrast in both selected (hover) and unselected states, light + dark mode.

## Overview

Authenticated users open Settings and are greeted by list rows whose description text fails WCAG AA in dark mode — 1.14:1 on the hovered blue row (muted-foreground on accent), and 3.35:1 on the unselected card (muted-foreground on card). Dark-mode `--muted-foreground` is too dim for both paired surfaces, and the row component never flips text to `accent-foreground` when the blue hover background activates. Fix the token, pair the row hover classes the shadcn way, and add a regression test.

---

## Audit current contrast and record baseline

Compute and log WCAG ratios for title + description across selected/unselected in both themes so the fix is evidence-driven.

**Requirements**:
- Given dark-mode hover state, should measure muted-foreground × accent and confirm failure
- Given dark-mode unselected state, should measure muted-foreground × card and confirm failure
- Given light mode, should confirm current tokens already pass AA

---

## Bump dark `--muted-foreground` token

Raise dark-mode `--muted-foreground` from `oklch(0.52 0 0)` to `oklch(0.64 0 0)` so secondary text on every dark surface clears 4.5:1 without disturbing light mode or any other token.

**Requirements**:
- Given dark-mode card surface, description text should reach ≥4.5:1 using `text-muted-foreground`
- Given other dark surfaces using muted-foreground (bg, sidebar, muted), should still reach ≥4.5:1
- Given light mode, should be untouched

---

## Pair hover bg with accent-foreground on `SettingsRow`

Rewrite the row to use the shadcn `group` pattern: `hover:bg-accent hover:text-accent-foreground` on the row, `group-hover:text-accent-foreground` on icon, description, and chevron — so the row flips every foreground when the saturated blue hover background activates.

**Requirements**:
- Given a row being hovered, should render all text + icons with `text-accent-foreground` (not `text-muted-foreground`)
- Given an unavailable ("Coming Soon") row, should not apply hover flip because the row is not interactive
- Given a row in its default state, should still render description/icons with `text-muted-foreground`

---

## Add regression test for row class composition

Unit-test `SettingsRow` so future edits can't silently reintroduce unpaired hover styles.

**Requirements**:
- Given an available row, the rendered element should include both `hover:bg-accent` and `hover:text-accent-foreground`
- Given an available row, the description span should include `group-hover:text-accent-foreground`

---

## Run lint, typecheck, unit tests

Verify the fix and token bump don't break anything else.

**Requirements**:
- Given `pnpm --filter web lint`, should exit clean
- Given `pnpm --filter web typecheck`, should exit clean
- Given `pnpm test:unit`, should exit clean

---

## Open PR against master

Ship the change with before/after evidence so reviewers can eyeball the contrast delta.

**Requirements**:
- Given the PR description, should include before/after WCAG ratios for dark-mode selected + unselected states
- Given the PR, should target `master` from the current branch
