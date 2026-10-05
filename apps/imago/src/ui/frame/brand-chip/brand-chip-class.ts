import { cn } from '../../cn';

/** The drive's mark at the top of the rail: its initial on a raised 34px tile (myimago brand chip). */
export const brandChipClass =
  'flex size-rail-brand items-center justify-center rounded-lg border border-hairline bg-surface-raised font-semibold text-ink';

/** The drive menu, opening beside the rail at the tooltip's offset, wide enough for drive names. */
export const driveMenuClass =
  'absolute top-0 left-rail-tooltip-x z-popover m-0 flex w-popover list-none flex-col rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised';

const driveLinkBase =
  'flex items-center gap-2 rounded-md px-2 py-row-y text-sm font-medium text-ink no-underline hover:no-underline';

/** One drive in the menu: a ~32px row, tinted when it is the open drive. */
export const driveLinkClass = (current: boolean): string =>
  cn(driveLinkBase, current ? 'bg-accent-soft' : 'hover:bg-surface-overlay');

/** A drive's initial beside its name in the menu. */
export const driveInitialClass =
  'flex size-avatar-xs flex-none items-center justify-center rounded-md border border-hairline bg-surface-raised text-2xs font-semibold';

/** The menu's line while the list loads, fails or is empty. */
export const driveNoteClass = 'px-2 py-row-y text-sm text-ink-muted';
