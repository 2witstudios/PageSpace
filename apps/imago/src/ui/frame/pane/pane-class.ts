/**
 * Every pane is always mounted. A fixed column (the left pane, Imago docked) carries an
 * explicit width token and animates it (`pane-motion`, --ease-pane, 320ms); the middle and
 * Imago on the ground take the rest (`grow`). `overflow-clip` hides what does not fit while a
 * width moves, so the content never reflows mid-slide.
 */
export const paneClass = (width: string): string =>
  width === 'grow'
    ? 'flex h-full min-w-0 flex-1 overflow-clip'
    : `flex h-full flex-none overflow-clip pane-motion ${width}`;

/** Every column starts with the same 48px head, so the hairlines form one line (SPEC v2/v3). */
export const paneHeaderClass =
  'flex h-pane-header flex-none items-center gap-1 border-b border-hairline pr-2 pl-4 text-sm';

/** A 28px ghost control in a head. */
export const paneControlClass =
  'flex size-head-control flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-ink-muted no-underline hover:bg-fill hover:text-ink hover:no-underline';
