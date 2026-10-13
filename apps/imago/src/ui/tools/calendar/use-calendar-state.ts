'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { parseCalendarState, withCalendarPatch, type CalendarPatch, type CalendarState } from './calendar-state';

/** The calendar's URL state, read by the pane and the middle alike; `update` replaces the address. */
export function useCalendarState(): { readonly state: CalendarState; readonly update: (patch: CalendarPatch) => void } {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const search = params.toString();
  const state = useMemo(() => parseCalendarState(new URLSearchParams(search), new Date()), [search]);
  const update = useCallback(
    (patch: CalendarPatch) => {
      router.replace(`${pathname}${withCalendarPatch(search, patch)}`, { scroll: false });
    },
    [pathname, router, search],
  );
  return { state, update };
}
