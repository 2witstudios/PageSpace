'use client';

import { useEffect, useState } from 'react';
import { useThemePreference } from '@/lib/theme/theme-provider';

export function useTheme() {
  const { preference, selectPreference } = useThemePreference();
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemTheme(media.matches ? 'dark' : 'light');
    sync(); media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return {
    theme: preference,
    resolvedTheme: preference === 'system' ? systemTheme : preference,
    themes: ['light', 'dark', 'system'],
    setTheme: (value: string) => {
      if (value === 'light' || value === 'dark' || value === 'system') selectPreference(value);
    },
  };
}
