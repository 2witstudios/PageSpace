/**
 * The viewport tiers of the v3 responsive rules (SPEC "v3 responsive rules"):
 *
 * - `desktop` (1280 and up): the frame as it is, Imago docked at 360px.
 * - `overlay` (1024 to 1279): the pane stays docked at 236px; Imago never docks and opens as a
 *   340px sheet over the page.
 * - `narrow` (600 to 1023): the pane becomes a left sheet opened by Show sidebar; Imago stays an
 *   overlay.
 * - `phone` (under 600): one column, the bottom bar in place of the spine.
 */
export type ViewportTier = 'desktop' | 'overlay' | 'narrow' | 'phone';

/** The first width of each tier above the phone. */
export const PHONE_MAX = 600;
export const NARROW_MAX = 1024;
export const OVERLAY_MAX = 1280;

/** The tier of a viewport width in CSS pixels. */
export const tierFor = (width: number): ViewportTier =>
  width < PHONE_MAX ? 'phone' : width < NARROW_MAX ? 'narrow' : width < OVERLAY_MAX ? 'overlay' : 'desktop';

/** Whether Imago and the pane float over the page instead of docking beside it. */
export const floatsOver = (tier: ViewportTier): boolean => tier !== 'desktop';

/** The three boundaries as media queries, so a tier changes only when a boundary is crossed. */
export const tierQueries: readonly string[] = [
  `(max-width: ${PHONE_MAX - 0.02}px)`,
  `(max-width: ${NARROW_MAX - 0.02}px)`,
  `(max-width: ${OVERLAY_MAX - 0.02}px)`,
];

/** The tier from which of the queries (phone, narrow, overlay) match. */
export const tierFromMatches = (matches: readonly boolean[]): ViewportTier =>
  matches[0] === true ? 'phone' : matches[1] === true ? 'narrow' : matches[2] === true ? 'overlay' : 'desktop';
