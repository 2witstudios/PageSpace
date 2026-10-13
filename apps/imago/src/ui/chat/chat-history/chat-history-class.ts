import { cn } from '../../cn';

/* One past chat, as the messages list draws a row: 32px and quiet (13px,
   normal weight, muted ink) so the history recedes behind the chat. Hover
   brings a row to full ink; the open chat takes the soft accent tint at full
   ink. The ink never turns blue. */
const base =
  'flex h-8 w-full cursor-pointer items-center rounded-lg px-2 text-left text-sm font-normal transition-colors duration-120 ease-standard';

export const chatHistoryRowClass = (selected: boolean): string =>
  cn(base, selected ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-overlay hover:text-ink');

export const chatHistoryTitleClass = 'min-w-0 flex-1 truncate';

/** Why the history has no rows: loading, failed or empty. */
export const chatHistoryNoteClass = 'px-2 text-sm text-ink-muted';

/** A row's time, right-aligned and faint. */
export const chatHistoryTimeClass = 'flex-none pl-2 text-xs text-ink-faint';

/** "Search chats": the 32px filter field above the rows, as the Files pane's. */
export const chatHistoryFilterClass =
  'mx-px mb-2 flex h-filter flex-none items-center gap-2 rounded-md bg-fill px-3 text-ink-faint';
