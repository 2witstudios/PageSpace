/* PageSpace's checkbox: a 16px square on the small radius, a strong
   border at rest, and the accent fill with a check once it is ticked.
   Focus draws the global 3px accent halo (globals.css :focus-visible). */
const base =
  'inline-flex size-checkbox flex-none cursor-pointer items-center justify-center rounded-sm border transition-colors duration-120 ease-standard';

const ticked = 'border-accent bg-accent text-accent-ink';

const open = 'border-border-strong text-transparent hover:border-ink-muted';

/** Classes for a checkbox, ticked or not. */
export const checkboxClass = (checked: boolean): string =>
  `${base} ${checked ? ticked : open}`;
