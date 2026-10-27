'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * URL-backed tab state (`?tab=`): reads the current tab from the query string
 * (falling back to `defaultTab` when missing/invalid) and returns a setter
 * that rewrites only the `tab` param, preserving everything else. Selecting
 * the default tab removes the param so the canonical URL stays clean.
 *
 * Uses useSearchParams, so callers must render inside a Suspense boundary.
 */
export function useUrlTab<T extends string>(validTabs: readonly T[], defaultTab: T): [T, (tab: T) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabParam = searchParams.get('tab');
  const tab: T = validTabs.includes(tabParam as T) ? (tabParam as T) : defaultTab;

  const setTab = useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === defaultTab) params.delete('tab');
      else params.set('tab', next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams, defaultTab],
  );

  return [tab, setTab];
}
