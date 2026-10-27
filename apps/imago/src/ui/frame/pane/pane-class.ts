/**
 * Every pane is always mounted. A fixed column (the left pane, Imago docked) carries an
 * explicit width token and animates it (`pane-motion`, --ease-pane, 320ms); the middle and
 * Imago on the ground take the rest (`grow`). `overflow-clip` hides what does not fit while a
 * width moves; its content follows the allocated width. While a seam drags it (`data-resizing`),
 * the width tracks the pointer instead of easing after it.
 */
export const paneClass = (width: string): string =>
  width === 'grow'
    ? 'flex h-full min-w-0 flex-1 overflow-clip'
    : `flex h-full flex-none overflow-clip pane-motion data-resizing:transition-none ${width}`;

/**
 * Every column starts with the same 48px head, so the hairlines form one line (SPEC v2/v3). On a
 * phone it is the 52px phone head, like the Files and page heads.
 */
export const paneHeaderClass =
  'flex h-pane-header flex-none items-center gap-1 border-b border-hairline pr-2 pl-4 text-sm phone:h-phone-head phone:pr-1 phone:pl-4 phone:text-base';

/** A 28px ghost control in a head; 40px on a phone. */
export const paneControlClass =
  'flex size-head-control flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-ink-muted no-underline hover:bg-fill hover:text-ink hover:no-underline phone:size-spine-tile-small phone:rounded-lg phone:text-ink';
