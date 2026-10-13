/**
 * The account menu, opening beside the rail's foot and growing upwards; as
 * wide as the theme switcher it holds.
 */
export const accountMenuClass =
  'absolute bottom-0 left-rail-tooltip-x z-popover m-0 flex w-max list-none flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised';

/** Who is signed in, above the actions. */
export const accountNameClass = 'px-2 py-row-y text-xs text-ink-muted';

/** A link or a button in the menu: the same ~32px row either way. */
export const accountItemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-row-y text-left text-sm font-medium text-ink no-underline hover:bg-surface-overlay hover:no-underline';
