import type { MarkColor } from '@pagespace/lib/avatars/avatar-core';

/* A drive mark sits in its surface's own tile shape; these are what it adds
   to it: a stacking box for the image laid over the initial. */
export const driveMarkClass = 'relative overflow-hidden';

/* The image covers the tile and the initial under it; it carries the tile's
   fill, so a transparent logo never shows the letter through. */
export const driveMarkImageClass = 'absolute inset-0 size-full object-cover';

/* The palette a drive may pick for its tile (MARK_COLORS), white on each. */
export const markFillClass: Readonly<Record<MarkColor, string>> = {
  slate: 'bg-mark-slate text-mark-on',
  red: 'bg-mark-red text-mark-on',
  orange: 'bg-mark-orange text-mark-on',
  amber: 'bg-mark-amber text-mark-on',
  green: 'bg-mark-green text-mark-on',
  teal: 'bg-mark-teal text-mark-on',
  blue: 'bg-mark-blue text-mark-on',
  indigo: 'bg-mark-indigo text-mark-on',
  violet: 'bg-mark-violet text-mark-on',
  pink: 'bg-mark-pink text-mark-on',
};
