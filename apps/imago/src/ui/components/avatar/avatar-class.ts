export type AvatarSize = 'stack' | 'xs' | 'sm' | 'md' | 'lg';

/** A person on the neutral, or an AI agent on the accent tint. */
export type AvatarTone = 'person' | 'agent';

const base =
  'relative inline-flex shrink-0 items-center justify-center rounded-round font-medium';

const sizes: Readonly<Record<AvatarSize, string>> = {
  /* The overlapping stack: a 24px face with a canvas-coloured ring that
     separates it from the face it overlaps, as PageSpace's does. */
  stack: 'size-avatar-stack border-2 border-background text-2xs',
  /* A list row's face, beside 13px text. */
  xs: 'size-avatar-xs border border-border text-2xs',
  sm: 'size-avatar-sm border border-border text-xs',
  md: 'size-avatar-md border border-border text-sm',
  lg: 'size-avatar-lg border border-border text-md',
};

const tones: Readonly<Record<AvatarTone, string>> = {
  person: 'bg-surface-overlay text-ink-muted',
  agent: 'bg-accent-soft text-accent',
};

export const avatarSizes = Object.keys(sizes) as readonly AvatarSize[];

/** Classes for an avatar of the given size and tone. */
export const avatarClass = (size: AvatarSize, tone: AvatarTone = 'person'): string =>
  `${base} ${sizes[size]} ${tones[tone]}`;

export const avatarImageClass = 'size-full rounded-round object-cover';

export const avatarInitialsClass = 'tracking-wide';

/** Seats the presence dot on the face's lower-right edge. */
export const avatarPresenceClass =
  'absolute -right-avatar-presence -bottom-avatar-presence inline-flex';
