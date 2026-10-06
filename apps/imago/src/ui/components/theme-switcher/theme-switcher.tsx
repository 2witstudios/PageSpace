'use client';

import { useThemePreference } from '@/lib/theme/theme-provider';
import { renderThemeSwitcher } from './theme-switcher.render';

/** Light / Dark / System control bound to the request's theme provider. */
export function ThemeSwitcher() {
  return renderThemeSwitcher(useThemePreference());
}
