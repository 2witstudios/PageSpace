export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

// 36px controls on the md radius. Variants never override the base: each
// owns its padding, so no two classes on one element set the same property.
const base =
  'inline-flex h-control cursor-pointer items-center justify-center gap-2 rounded-md border text-base leading-tight font-medium transition-colors duration-120 ease-standard';

const variants: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'border-transparent bg-accent px-4 text-accent-ink hover:bg-accent-strong',
  secondary:
    'border-border-strong bg-transparent px-4 text-ink hover:border-ink-muted',
  ghost:
    'border-transparent bg-transparent px-3 text-ink-muted hover:bg-surface-overlay hover:text-ink',
};

/** Classes for a button of the given variant. */
export const buttonClass = (variant: ButtonVariant): string =>
  `${base} ${variants[variant]}`;
