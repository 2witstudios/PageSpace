import { cn } from '../../cn';

/* The folder browser in the object column (C-Files-Browser): a 44px Files
   strip over the folder's contents, a list table or a grid of tiles, or the
   empty state while the folder holds nothing. Token-locked: only the v3
   colours and the shell's own classes. */

/** The browser fills the object column: strip over the scrolling body. */
export const browserClass = 'flex h-full min-h-0 flex-col';

/** The scrolling body under the strip. */
export const browserBodyClass = 'min-h-0 flex-1 overflow-auto px-8 pb-12 pt-5';

/** The column the contents sit in, centred and capped at the board's 1024px. */
export const browserContentClass = 'relative mx-auto max-w-browser';

/** The breadcrumb path, one line, truncating from the left-most crumb. */
export const crumbsClass = 'flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap text-sm';

export const crumbClass = (current: boolean): string =>
  cn('no-underline hover:underline', current ? 'font-semibold text-ink' : 'text-ink-muted');

export const crumbSepClass = 'text-ink-faint';

/** The List / Grid pair: the pressed one takes a faint wash. */
export const viewGroupClass = 'flex gap-1';

export const viewButtonClass = (pressed: boolean): string =>
  cn(
    'grid size-8 cursor-pointer place-items-center rounded-md border-0 transition-colors',
    pressed ? 'bg-fill text-ink' : 'bg-transparent text-ink-muted hover:text-ink',
  );

/** The table's column heading: a sortable button that keeps the table's rhythm. */
export const sortButtonClass =
  'inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 -ml-2 text-xs font-medium text-ink-muted hover:text-ink';

export const headCellClass = 'border-b border-hairline px-2 pb-2 text-left';

export const tableClass = 'w-full border-collapse text-sm';

/** A row: ruled by a hairline and tinted on hover; a row still being created is faded. */
export const rowClass = (pending: boolean, menuOpen: boolean): string =>
  cn(
    'group border-b border-hairline transition-colors duration-120 hover:bg-tint',
    menuOpen && 'bg-tint',
    pending && 'opacity-60',
  );

export const nameCellClass = 'h-10 px-2';

export const nameLinkClass =
  'flex min-w-0 items-center gap-2 font-medium text-ink no-underline hover:no-underline';

export const metaCellClass = 'h-10 whitespace-nowrap px-2 text-ink-muted';

export const dateCellClass = 'h-10 whitespace-nowrap px-2 text-right tabular-nums text-ink-muted';

/** The hover "…" button at the row's end; it shows on hover, focus or while its menu is open. */
export const moreButtonClass = (open: boolean): string =>
  cn(
    'grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-ink-muted transition-opacity hover:bg-fill hover:text-ink',
    open ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100',
  );

export const hintClass = 'mt-4 pl-2 text-xs text-ink-faint';

export const tilesClass = 'grid grid-cols-6 gap-1';

export const tileClass = (selected: boolean): string =>
  cn(
    'flex flex-col items-center gap-2 rounded-lg px-1 pb-2 pt-2 text-ink no-underline hover:bg-tint',
    selected && 'bg-accent-soft',
  );

export const tileTitleClass =
  'line-clamp-2 w-full break-words text-center text-xs leading-tight text-ink';

/** The empty folder's box; a drop turns its border into the accent. */
export const emptyClass = (dropping: boolean): string =>
  cn(
    'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-16 text-center',
    dropping ? 'border-accent bg-accent-soft' : 'border-transparent',
  );

export const emptyTitleClass = 'text-base font-medium text-ink';

export const emptyDetailClass = 'text-sm text-ink-muted';

export const emptyActionsClass = 'mt-2 flex gap-2';

export const dropNoteClass = 'mt-3 text-xs font-medium text-accent-deep';

/** A file the browser is not dropping into: the whole list takes the accent border while files are over it. */
export const dropZoneClass = (dropping: boolean): string =>
  cn('relative rounded-xl border-2 border-dashed', dropping ? 'border-accent' : 'border-transparent');

export const alertClass = 'mb-3 px-2 text-sm text-status-danger';

/** The row's context menu: a floating card at the pointer. */
export const menuClass =
  'fixed z-popover flex w-menu flex-col gap-1 rounded-lg border border-hairline bg-tint p-1 shadow-sheet';

export const menuItemClass = (danger: boolean): string =>
  cn(
    'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-sm text-ink no-underline hover:bg-fill',
    danger && 'text-status-danger',
  );

export const menuSeparatorClass = 'my-1 h-px bg-hairline';
