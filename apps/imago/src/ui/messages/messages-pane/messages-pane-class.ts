import { cn } from '../../cn';

/* One row of the messages list, as myimago's tree row draws it: 32px and
   quiet (13px, normal weight, muted ink) so the list recedes behind the
   thread. Hover brings a row to full ink; the open thread takes the soft
   accent tint at full ink. The ink never turns blue. */
const base =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline';

const state = (selected: boolean, unread: boolean): string => {
  if (selected) return 'bg-accent-soft font-normal text-ink';
  if (unread) return 'font-medium text-ink hover:bg-surface-overlay';
  return 'font-normal text-ink-muted hover:bg-surface-overlay hover:text-ink';
};

/**
 * A channel or DM row. A row holding something unread is the one row that
 * lifts, to medium weight at full ink, until it is opened (myimago ADR 0029
 * decision 11).
 */
export const messageRowClass = ({ selected, unread }: { readonly selected: boolean; readonly unread: boolean }): string =>
  cn(base, state(selected, unread));

export const messageNameClass = 'min-w-0 flex-1 truncate';

export const messageGlyphClass = 'flex-none text-ink-faint';

/** Why a section has no rows: loading, failed, empty or no drive. */
export const messagesNoteClass = 'px-2 text-sm text-ink-muted';
