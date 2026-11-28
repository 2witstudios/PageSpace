import { cn } from '../../cn';

/* A folder opened as the object (C-Files-Folder): a 44px Folder tools strip
   over a full-width table, one 44px row per page the folder holds. Names
   read at full ink; the type dot, kind and time recede. */

/** The browser fills the object column: tools strip over the contents. */
export const folderViewClass = 'flex h-full min-h-0 flex-col';

/** "<name> · <n> pages", muted, on one line in the strip. */
export const folderCountClass = 'whitespace-nowrap text-xs text-ink-muted';

/** The strip's Browse files link: a bordered button-sized link. */
export const folderBrowseClass =
  'ml-2 inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-hairline px-2 py-1 text-sm text-ink no-underline hover:bg-surface-overlay';

/** The scrolling body under the strip. */
export const folderBodyClass = 'min-h-0 flex-1 overflow-auto px-10 pb-12 pt-5';

/** The table's column, centred in the body and capped at the board's 860px. */
export const folderContentClass = 'mx-auto max-w-folder';

export const folderTableClass = 'w-full border-collapse text-sm';

/** A column's name. */
export const folderHeadClass = 'border-b border-hairline px-2 pb-2 text-left text-xs font-medium text-ink-muted';

/** The Modified column's name, right-aligned over its times. */
export const folderHeadEndClass = cn(folderHeadClass, 'text-right');

/** A row, ruled by a hairline and tinted on hover; a row still being created is faded. */
export const folderRowClass = (pending: boolean): string =>
  cn('border-b border-hairline transition-colors duration-120 ease-standard hover:bg-surface-overlay', pending && 'opacity-60');

/** The name cell: the type dot and the title. */
export const folderCellClass = 'h-10 px-2';

/** The coloured type dot; its hue comes from the page type's text-type-* class beside it. */
export const folderDotClass = 'inline-block size-2 shrink-0 rounded-full bg-current';

/** The row's name opens the page: dot and title at full ink, never underlined. */
export const folderLinkClass = 'flex min-w-0 items-center gap-2 font-medium text-ink no-underline hover:no-underline';

export const folderNameClass = 'min-w-0 truncate';

/** The "Creating…" hint beside a page still being created. */
export const folderCreatingClass = 'text-xs font-normal text-ink-faint';

/** The Type column: the kind, muted, on one line. */
export const folderKindClass = 'h-10 whitespace-nowrap px-2 text-ink-muted';

/** The Modified column: the time, muted and right-aligned. */
export const folderWhenClass = 'h-10 whitespace-nowrap px-2 text-right tabular-nums text-ink-muted';
