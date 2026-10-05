import { cn } from '../../cn';

/*
 * The ⌘K palette: a raised glass sheet over the whole frame, a third of the
 * way down as a launcher sits. The layer covers the frame so a press outside
 * the sheet lands on it and closes the palette; it is not tinted.
 */
export const paletteLayerClass = 'fixed inset-0 z-popover flex items-start justify-center px-4 pt-16';

/** The sheet: as wide as a document column, the ladder's sheet corner. */
export const paletteSheetClass =
  'flex w-full max-w-doc flex-col overflow-hidden rounded-xl border border-hairline shadow-3 surface-glass-raised';

/** The field row: the search icon, the input, and the scope toggle. */
export const paletteFieldClass = 'flex items-center gap-2 border-b border-hairline px-3 text-ink-muted';

/* Borderless inside the row; `outline-none` leaves the global accent halo
   to mark focus. Composer height, base size: this is the one field. */
export const paletteInputClass =
  'h-composer-field min-w-0 flex-1 border-none bg-transparent text-base text-ink outline-none placeholder:text-ink-faint';

/** "Include all workspaces" beside the field. */
export const paletteScopeClass = 'flex flex-none items-center gap-2 text-xs text-ink-muted';

export const paletteListClass = 'm-0 flex list-none flex-col gap-1 p-1';

const rowBase =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-120 ease-standard';

/** A result: quiet like a tree row, tinted while highlighted. */
export const paletteRowClass = (active: boolean): string =>
  cn(rowBase, active ? 'bg-accent-soft text-ink' : 'text-ink-muted');

export const paletteTitleClass = 'min-w-0 flex-1 truncate';

/** The drive a result lives in, while searching every drive. */
export const paletteDriveClass = 'flex-none truncate text-2xs text-ink-faint';

/** Searching, nothing found, or a failure, under the field. */
export const paletteNoteClass = 'px-3 py-row-y text-sm text-ink-muted';
