/**
 * Every pane is always mounted and carries an explicit width token; the
 * stage's widths sum to the frame (frame.css), so a stage change is one
 * width transition per pane on --ease-pane over 320ms (`pane-motion`).
 * `flex-none` keeps the token exact and `overflow-clip` hides what does not
 * fit while the width moves, so the content never reflows mid-slide.
 */
export const paneClass = (width: string): string =>
  `flex h-full flex-none overflow-clip pane-motion ${width}`;

/** Every pane starts with the same 52px header and hairline. */
export const paneHeaderClass =
  'flex h-pane-header flex-none items-center gap-2 border-b border-hairline px-3';

/** A borderless icon control in a pane header: close, or the hamburger. */
export const paneControlClass =
  'flex size-8 flex-none items-center justify-center rounded-md text-ink-muted hover:bg-surface-overlay hover:text-ink';
