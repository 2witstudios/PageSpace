export type IconButtonTone = 'quiet' | 'reveal';

// 32px square controls on the md radius. Each tone owns its transition and
// hover ink, so a caller never overrides the base with the same property.
const base =
  'inline-flex size-8 cursor-pointer items-center justify-center rounded-md bg-transparent text-ink-muted duration-120 ease-standard hover:bg-surface-overlay';

const tones: Readonly<Record<IconButtonTone, string>> = {
  quiet: 'transition-colors hover:text-ink',
  // Dimmed until its `group` row is hovered, then accent.
  reveal:
    'opacity-75 transition group-hover:text-accent group-hover:opacity-100',
};

/** Classes for an icon button of the given tone. */
export const iconButtonClass = (tone: IconButtonTone): string =>
  `${base} ${tones[tone]}`;
