/* At rest: a quiet "+ Add" row that lifts on hover. */
export const inlineAddRestClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-row-y text-left text-sm text-ink-faint transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink';

/* Open: a row-height field with the strong border. `outline-none` leaves
   the global 3px accent halo (a box-shadow) to mark focus. */
export const inlineAddFieldClass =
  'w-full rounded-lg border border-border-strong bg-background px-2 py-row-y text-sm text-ink outline-none placeholder:text-ink-faint';
