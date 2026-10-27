import { cn } from '../../cn';

/**
 * The 64px blue bar that replaces the spine on a phone (C-Resp-Phone-Tree); its ground runs on
 * under the home indicator.
 */
export const phoneBarClass =
  'phone-safe-bar flex h-phone-bar flex-none items-stretch bg-spine px-1 text-spine-on';

/** One bar item: icon over a 10.5px label, the active one marked at its top edge. */
export const phoneBarItemClass = (current: boolean): string =>
  cn(
    'relative flex flex-1 flex-col items-center justify-center gap-1 rounded-xl text-2xs no-underline hover:no-underline',
    current ? 'font-semibold text-spine-on' : 'font-medium text-spine-dim',
  );

/** The 28px by 3px tab at the top edge of the active item. */
export const phoneBarMarkerClass = 'absolute top-1 h-1 w-8 rounded-b-sm bg-spine-marker';
