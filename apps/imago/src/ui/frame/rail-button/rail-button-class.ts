import { cn } from '../../cn';

/* The hit box is 44px and the chip inside it 38px: the mockups' 38px target
   is below the accessible floor, and the ring belongs on the real control
   (myimago ADR 0029 decision 4). Variants never override the base: each owns
   its colors. */
const hitBase =
  'group relative flex size-rail-hit flex-none items-center justify-center rounded-lg no-underline hover:no-underline';

const chipBase =
  'flex size-rail-chip items-center justify-center rounded-lg transition-colors duration-120 ease-standard';

/** Classes for the rail control itself: the 44px hit box. */
export const railHitClass = (enabled: boolean): string =>
  cn(hitBase, enabled ? 'cursor-pointer' : 'cursor-default');

/** Classes for the visible 38px chip inside the hit box. */
export const railChipClass = (active: boolean, enabled: boolean): string =>
  cn(
    chipBase,
    active
      ? 'bg-accent-soft text-ink'
      : enabled
        ? 'text-ink-muted group-hover:bg-surface-overlay group-hover:text-ink'
        : 'text-ink-faint',
  );

/** The rail's destination list, and the one pinned to its foot. */
export const railListClass = 'm-0 flex list-none flex-col items-center gap-rail-gap p-0';

export const railPinnedClass = 'm-0 mt-auto flex list-none flex-col items-center gap-rail-gap p-0';

/** The label beside a hovered or focused control; the control carries the name. */
export const railTooltipClass =
  'pointer-events-none invisible absolute top-1/2 left-rail-tooltip-x z-popover -translate-y-1/2 rounded-md border border-hairline bg-surface-raised px-2 py-1 text-2xs whitespace-nowrap text-ink opacity-0 shadow-2 transition-opacity duration-120 ease-standard group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100';

/** Where an unread count sits on a rail control: its top-right corner. */
export const railUnreadClass = 'absolute top-0 right-0';

/** The ⋯ overflow's menu, opening beside the rail at the tooltip's offset. */
export const overflowMenuClass =
  'absolute top-0 left-rail-tooltip-x z-popover m-0 flex w-menu list-none flex-col rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised';

/** One classic deep link in the overflow menu: a ~32px sidebar row. */
export const overflowLinkClass =
  'flex items-center gap-2 rounded-md px-2 py-row-y text-sm font-medium text-ink no-underline hover:bg-surface-overlay hover:no-underline';
