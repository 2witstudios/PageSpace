/** The page head: 48px, like every column head (SPEC v3.3). */
export const pageHeadClass =
  'flex h-pane-header flex-none items-center gap-1 border-b border-hairline pr-2 pl-4 text-sm';

export const crumbsClass = 'm-0 flex min-w-0 flex-1 list-none items-center gap-1 overflow-hidden p-0 whitespace-nowrap';

export const crumbClass = (current: boolean): string =>
  current ? 'min-w-0 truncate font-semibold text-ink' : 'flex-none text-ink-muted';

export const crumbSeparatorClass = 'flex-none text-ink-faint';

export const pageActionsMenuClass =
  'absolute top-full right-0 z-popover mt-1 flex w-max min-w-menu flex-col gap-1 rounded-lg border border-hairline bg-surface-raised p-1 shadow-2';
