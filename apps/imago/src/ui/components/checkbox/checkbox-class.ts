/* PageSpace's checkbox: a 16px square on the small radius, a strong
   border at rest, and the accent fill with a check once it is ticked.
   Focus draws the global 3px accent halo (globals.css :focus-visible).
   A read-only one shows its state without the pointer or the hover. */
const base = (cursor: string): string =>
  `inline-flex size-checkbox flex-none ${cursor} items-center justify-center rounded-sm border transition-colors duration-120 ease-standard`;

const ticked = 'border-accent bg-accent text-accent-ink';

const open = 'border-border-strong text-transparent';

const hover = 'hover:border-ink-muted';

/** Classes for a checkbox, ticked or not, and changeable or read-only. */
export const checkboxClass = (checked: boolean, readOnly = false): string =>
  readOnly
    ? `${base('cursor-default')} ${checked ? ticked : open}`
    : `${base('cursor-pointer')} ${checked ? ticked : `${open} ${hover}`}`;
