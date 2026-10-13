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

/** The avatar's control at the spine's foot; ringed while the account is open (SPEC v3). */
export const avatarSummaryClass = (active: boolean): string =>
  active ? 'group relative flex cursor-pointer summary-plain spine-avatar-ring' : 'group relative flex cursor-pointer summary-plain';

/** The name and the email above the rows. */
export const accountHeadClass = 'flex flex-col gap-1 px-2 pt-1 pb-2';

export const accountEmailClass = 'truncate text-xs font-normal text-ink-faint';

/** The credits card: a tinted block above the rows (C-Shell-AccountMenu). */
export const creditsCardClass = 'mx-1 mb-1 flex flex-col gap-2 rounded-md border border-hairline bg-tint p-3';

export const creditsHeadClass = 'flex items-baseline justify-between gap-2 text-xs text-ink-muted';

export const creditsFigureClass = 'text-sm font-semibold tabular-nums text-ink';

export const creditsMeterClass = 'h-1 w-full overflow-hidden rounded-full bg-fill';

export const creditsMeterFillClass = 'h-full rounded-full bg-accent-deep';

export const creditsNoteClass = 'text-xs text-ink-faint';

export const creditsBuyClass = 'inline-flex items-center gap-1 pt-1 text-xs font-medium text-accent-deep no-underline hover:underline';

/** A row's trailing figure, such as Usage's "612 / 900". */
export const accountCountClass = 'ml-auto text-xs tabular-nums text-ink-muted';

/** The "Unverified" tag on the Verify Email row. */
export const accountBadgeClass = 'ml-auto rounded-md px-2 py-1 text-xs font-medium text-status-warning-ink bg-status-warning/10';
