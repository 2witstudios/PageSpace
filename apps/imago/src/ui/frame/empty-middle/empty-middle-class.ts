/** The empty middle's column: the 48px head, then the centred block (SPEC v3.2). */
export const emptyMiddleClass = 'flex h-full min-w-0 flex-1 flex-col';

export const emptyHeadClass =
  'flex h-pane-header flex-none items-center gap-1 border-b border-hairline pr-2 pl-4 text-sm text-ink-faint';

export const emptyBodyClass = 'flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8';

export const emptyBlockClass = 'flex w-full max-w-empty-middle flex-col items-center gap-1 text-center';

export const emptyTitleClass = 'm-0 text-md font-semibold text-ink';

export const emptyLineClass = 'm-0 text-sm text-ink-muted';

export const emptyRecentsClass = 'mt-4 mb-3 flex w-full flex-col gap-px';

export const emptyGroupLabelClass =
  'px-2 pb-1 text-left text-2xs font-medium tracking-wide text-ink-muted uppercase';

/** A recent: 36px row, type icon, title, age. */
export const emptyRowClass =
  'flex h-empty-row items-center gap-2 rounded-md px-2 text-sm text-ink no-underline hover:bg-fill hover:no-underline';

/** "Ask Imago": the spark pill in spine blue that reopens Imago in the middle. */
export const askImagoClass =
  'flex h-ask-imago cursor-pointer items-center gap-2 rounded-round border-0 bg-spine px-3 text-sm font-medium text-spine-on';
