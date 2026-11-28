import type { TextSize } from '@/lib/text-size/text-size-preference';
import { optionStates } from '../theme-switcher/theme-switcher-class';

/** The row: the theme switcher's sunken track, spanning the menu. */
export const textSizeSwitcherClass = 'flex w-full gap-1 rounded-md border border-border bg-surface-sunken p-1';

const base =
  'inline-flex h-8 flex-1 cursor-pointer items-center justify-center rounded-md border font-medium leading-tight transition-colors duration-120 ease-standard';

/** Each choice's "A", a step larger than the one before it. */
const glyphs: Readonly<Record<TextSize, string>> = {
  small: 'text-xs',
  default: 'text-sm',
  large: 'text-md',
  larger: 'text-lg',
};

/** Classes for a size's "A", pressed (the theme switcher's checked look) or not. */
export const textSizeOptionClass = (size: TextSize, pressed: boolean): string =>
  `${base} ${glyphs[size]} ${pressed ? optionStates.checked : optionStates.unchecked}`;
