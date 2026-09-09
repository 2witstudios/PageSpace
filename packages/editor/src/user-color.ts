import { djb2 } from './collab-schema.js';

/**
 * One deterministic colour per user, for the avatar ring in the presence
 * roster and the `CollaborationCaret` label.
 *
 * The presence roster and Yjs awareness are two channels that never talk to
 * each other, and both draw the same user. Agreeing on a colour through either
 * channel would mean one of them owning an assignment table and the other
 * reading it — a lookup, a race on first sight, and a stale colour after a
 * reconnect. A pure function of the id needs none of that: every client, on
 * every reconnect, with no state, arrives at the same answer.
 *
 * The palette is fixed and small on purpose. A colour is a label people learn
 * ("the green cursor is Ada"), so it must be one of a set that is legible at
 * two-pixel caret width and one-pixel ring width on BOTH themes. Every entry
 * holds a WCAG 1.4.11 non-text contrast of at least 3:1 against pure white and
 * against the app's lightest dark surface (`--card`, oklch 0.23 ≈ #1d1d1d);
 * `__tests__/user-color.test.ts` recomputes that from the hex values rather
 * than trusting this comment. Twelve hues, thirty degrees apart, at a
 * relative luminance of ~0.20 — the band where both bounds are met with
 * margin. Two users CAN share a colour; with twelve entries that is a fact,
 * not a bug, and the roster shows names.
 *
 * Changing an entry, or the hash, recolours every existing user everywhere at
 * once. The test pins three ids to their colours so that happens as a visible
 * diff, never as a side effect.
 */
export const USER_COLOR_PALETTE: readonly string[] = [
  '#d54e4e', // red
  '#b06c29', // orange
  '#7f7f1e', // olive
  '#558920', // lime
  '#218f21', // green
  '#218d57', // teal-green
  '#208888', // teal
  '#307fcd', // blue
  '#7070dd', // indigo
  '#9b5ed9', // violet
  '#cf32cf', // magenta
  '#d3458c', // pink
];

/** A palette colour, `#rrggbb`, chosen by `userId` alone. */
export function userColor(userId: string): string {
  return USER_COLOR_PALETTE[djb2(userId) % USER_COLOR_PALETTE.length];
}
