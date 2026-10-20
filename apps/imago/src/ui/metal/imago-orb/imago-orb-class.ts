import { cn } from '../../cn';

/**
 * Where Imago's orb is drawn (docs/imago/liquid-metal-engine.md "Where Imago appears"): the
 * empty chat's hero, a post's author, the rail's Chat tile, the chat head's tile, a picker row, and the
 * glyph it takes in lists, tabs and the Ask buttons.
 */
export type OrbSize = 'hero' | 'avatar' | 'rail' | 'tile' | 'row' | 'glyph';

const sizes: Readonly<Record<OrbSize, string>> = {
  hero: 'size-orb-hero',
  /** A post's author, beside the people's faces. */
  avatar: 'size-avatar-sm',
  rail: 'size-orb-rail',
  tile: 'size-orb-tile',
  /** Overhangs its slot: laid out as a 30px agent tile, drawn larger. */
  row: 'size-orb-row -m-orb-row-overhang',
  glyph: 'size-orb-glyph',
};

/** What the orb sits on, when that is not the page: the engine lights it for that surface. */
export type OrbSurface = 'dark';

export const orbSizes = Object.keys(sizes) as readonly OrbSize[];

/** The orb's canvas: a block of its size; without the engine, a still chrome ball. */
export const imagoOrbClass = (size: OrbSize, fallback: boolean): string =>
  cn('block flex-none', sizes[size], fallback && 'orb-chrome');
