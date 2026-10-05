/* PageSpace's segmented switch: the checked segment lifts off a quiet
   overlay track. The lift is a box-shadow, which would hide the global
   focus halo (globals.css :focus-visible), so a focused segment trades it
   for the same 3px accent halo. */
export const segmentedControlClass =
  'inline-flex flex-none items-center gap-1 rounded-md bg-surface-overlay p-badge-y';

const base =
  'cursor-pointer rounded-sm px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-120 ease-standard focus-visible:shadow-focus';

const checked = 'bg-background text-ink shadow-ambient';

const unchecked = 'text-ink-muted hover:text-ink';

/** Classes for one segment, checked or not. */
export const segmentClass = (isChecked: boolean): string =>
  `${base} ${isChecked ? checked : unchecked}`;

/** The count after a segment's label, as in "Mine · 7". */
export const segmentCountClass = 'text-ink-faint tabular-nums';
