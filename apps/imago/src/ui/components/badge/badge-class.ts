// No red tone: counts and status read in the accent, never the live red.
export const badgeTones = ['neutral', 'accent'] as const;

export type BadgeTone = (typeof badgeTones)[number];

const base =
  'inline-flex items-center gap-1 rounded-md px-badge-x py-badge-y text-xs leading-tight font-medium whitespace-nowrap';

const tones: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-surface-overlay text-ink-muted',
  accent: 'bg-accent-soft text-accent',
};

/** Classes for a badge of the given tone. */
export const badgeClass = (tone: BadgeTone): string => `${base} ${tones[tone]}`;
