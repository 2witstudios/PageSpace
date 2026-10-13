import { cn } from '../../cn';

/* A group row (C-Members): the name on the left, its live count on the right in mono. */
export const memberGroupRowClass = cn(
  'flex h-8 w-full items-center justify-between gap-2 rounded-lg px-2 text-sm no-underline',
  'text-ink-muted transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink hover:no-underline',
);

export const memberGroupCountClass = 'flex-none font-mono text-2xs tabular-nums text-ink-faint';

/** The Manage links (Invite someone, Roles & permissions): the same row, without a count. */

export const membersPaneMessageClass = 'px-2 text-sm text-ink-muted';
