import { cn } from '../../cn';

/**
 * Where Imago's orb is drawn (docs/imago/liquid-metal-engine.md "Where Imago appears"): the
 * empty chat's hero, a post's author, the chat head's tile, a picker row, and the glyph it takes in lists,
 * tabs, the rail and the Ask buttons.
 */
export type OrbSize = 'hero' | 'avatar' | 'tile' | 'row' | 'glyph';

const sizes: Readonly<Record<OrbSize, string>> = {
  hero: 'size-orb-hero',
  /** A post's author, beside the people's faces. */
  avatar: 'size-avatar-sm',
  tile: 'size-agent-tile',
  row: 'size-agent-row-tile',
  glyph: 'size-orb-glyph',
};

export const orbSizes = Object.keys(sizes) as readonly OrbSize[];

/** The orb's canvas: a block of its size; without the engine, a still chrome ball. */
export const imagoOrbClass = (size: OrbSize, fallback: boolean): string =>
  cn('block flex-none', sizes[size], fallback && 'orb-chrome');
