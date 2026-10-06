import { cn } from '../../cn';

/* A folder opened as the object, as Finder's list view draws one: the path
   to it on top, then one quiet 32px row per page it holds. Names read at
   full ink; kind and time recede, like the tree's counts. */

/** The browser fills the object column: path bar over the list. */
export const folderViewClass = 'flex h-full flex-col gap-4 p-4';

/** The path from the drive down to the folder, one crumb after another. */
export const folderPathClass = 'flex min-w-0 flex-wrap items-center gap-1 text-sm text-ink-muted';

/** One crumb with the › ahead of it. */
export const folderCrumbItemClass = 'flex items-center gap-1';

/** A crumb that leads back up: muted until hovered. */
export const folderCrumbClass = 'text-ink-muted no-underline hover:text-ink';

/** The open folder's own crumb. */
export const folderCrumbCurrentClass = 'font-semibold text-ink';

/** The › between crumbs. */
export const folderCrumbSeparatorClass = 'text-ink-faint';

export const folderTableClass = 'w-full border-collapse text-sm';

/** A column's name. */
export const folderHeadClass = 'h-8 border-b border-hairline px-2 text-left text-xs font-medium text-ink-faint';

/** A row, ruled by a hairline and tinted on hover; a row still being created is faded. */
export const folderRowClass = (pending: boolean): string =>
  cn('border-b border-hairline transition-colors duration-120 ease-standard hover:bg-surface-overlay', pending && 'opacity-60');

/** The name cell. */
export const folderCellClass = 'h-8 px-2';

/** The row's name opens the page: icon and name, at full ink, never underlined. */
export const folderLinkClass = 'flex min-w-0 items-center gap-2 text-ink no-underline hover:no-underline';

export const folderNameClass = 'min-w-0 truncate';

/** Kind and Modified: muted, on one line. */
export const folderMetaClass = 'h-8 whitespace-nowrap px-2 text-ink-muted';
