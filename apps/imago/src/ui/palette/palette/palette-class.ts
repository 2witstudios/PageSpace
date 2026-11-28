import { cn } from '../../cn';

/*
 * The ⌘K palette: a raised glass sheet over the whole frame, a third of the
 * way down as a launcher sits. The layer covers the frame so a press outside
 * the sheet lands on it and closes the palette; it is not tinted.
 */
export const paletteLayerClass = 'fixed inset-0 z-popover flex items-start justify-center px-4 pt-16';

/** The sheet: narrower than a document column, the ladder's sheet corner, never taller than the viewport. */
export const paletteSheetClass =
  'flex max-h-palette-sheet w-full max-w-palette flex-col overflow-hidden rounded-xl border border-hairline shadow-3 surface-glass-raised';

/** The field row: the search icon, the input, and the scope switch, ruled off from the results. */
export const paletteFieldClass = 'flex h-palette-field flex-none items-center gap-3 border-b border-hairline pr-3 pl-4';

export const paletteSearchIconClass = 'flex-none text-accent';

/* Borderless and haloless inside the row. The sheet is modal and the caret
   sits in the field, so focus is never in doubt; a halo here is clipped by
   the sheet's corner and stops short of the icon, so it never reads as one
   ring all the way round. */
export const paletteInputClass =
  'h-full min-w-0 flex-1 border-none bg-transparent text-md tracking-tight text-ink outline-none placeholder:text-ink-faint focus-visible:shadow-none';

/** The scope switch: the open drive or every drive, a sunken track holding two segments. */
export const paletteScopeClass = 'flex flex-none gap-1 rounded-md border border-hairline bg-surface-sunken p-1';

export const paletteScopeOptionClass = (selected: boolean): string =>
  cn(
    'h-6 max-w-palette-scope cursor-pointer truncate rounded-sm px-2 text-xs font-medium transition-colors duration-120 ease-standard',
    selected ? 'bg-surface-overlay text-ink shadow-1' : 'text-ink-muted hover:text-ink',
  );

/** The results take what height the sheet has left and scroll inside it. */
export const paletteListClass = 'm-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto px-2 pt-1 pb-2';

/** A group's heading in the results: Pages, People, Recently updated. */
export const paletteGroupClass = 'flex flex-none flex-col';

export const paletteGroupLabelClass = 'px-2 pt-3 pb-1 text-2xs font-semibold tracking-caps text-ink-faint uppercase';

/** A result: quiet like a tree row, tinted while highlighted. */
export const paletteRowClass = (active: boolean): string =>
  cn(
    'flex h-palette-row w-full cursor-pointer items-center gap-3 rounded-lg px-2 text-left text-base text-ink transition-colors duration-120 ease-standard',
    active && 'bg-accent-soft',
  );

/** The tile behind a result's icon, taking the accent with its row. */
export const paletteTileClass = (active: boolean): string =>
  cn(
    'flex size-palette-tile flex-none items-center justify-center rounded-md',
    active ? 'bg-accent-soft text-accent-strong' : 'bg-surface-overlay text-ink-muted',
  );

/** A result's title over the drive it lives in. */
export const paletteTextClass = 'flex min-w-0 flex-1 flex-col';

export const paletteTitleClass = 'truncate font-medium';

/** The part of a title the query matched. */
export const paletteMatchClass = 'text-accent-strong';

/** The drive a result lives in, while searching every drive. */
export const paletteDriveClass = 'truncate text-xs text-ink-faint';

/** Searching, nothing found, or a failure, under the field. */
export const paletteNoteClass = 'flex-none px-4 py-3 text-sm text-ink-muted';

/** The keyboard hints under the results. */
export const paletteFooterClass =
  'flex flex-none flex-wrap items-center gap-4 border-t border-hairline px-4 py-2 text-xs text-ink-faint';

export const paletteHintClass = 'flex items-center gap-1';

/** The last hint, Escape, sits at the far end. */
export const paletteHintEndClass = 'ml-auto flex items-center gap-1';

/** A key cap: raised in the footer, accent on the highlighted row. */
export const paletteKbdClass = (tone: 'key' | 'accent'): string =>
  cn(
    'inline-flex h-palette-kbd min-w-palette-kbd flex-none items-center justify-center rounded-sm px-1 font-mono text-2xs',
    tone === 'accent' ? 'bg-accent-soft text-accent-strong' : 'bg-surface-overlay text-ink-muted shadow-1',
  );
