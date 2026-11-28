export const switcherClass =
  'inline-flex gap-1 rounded-md border border-border bg-surface-sunken p-1';

const base =
  'inline-flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors duration-120 ease-standard';

const states = {
  checked: 'border-border bg-surface-raised text-ink shadow-1',
  unchecked: 'border-transparent bg-transparent text-ink-muted hover:text-ink',
} as const;

/** Classes for a theme option in its checked or unchecked state. */
export const optionClass = (checked: boolean): string =>
  `${base} ${checked ? states.checked : states.unchecked}`;
