'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { stageFor, toolViewSegment } from '../../frame/stage/stage';
import { parseCalendarState, withCalendarPatch, type CalendarPatch, type CalendarState } from './calendar-state';

/**
 * The calendar's URL state, read by the pane and the middle alike. On the calendar's screen
 * `update` replaces the address; from the pane alone (a date picked, Event) it opens the screen.
 */
export function useCalendarState(): { readonly state: CalendarState; readonly update: (patch: CalendarPatch) => void } {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const search = params.toString();
  const state = useMemo(() => parseCalendarState(new URLSearchParams(search), new Date()), [search]);
  const update = useCallback(
    (patch: CalendarPatch) => {
      const next = withCalendarPatch(search, patch);
      if (stageFor(pathname).object !== null) router.replace(`${pathname}${next}`, { scroll: false });
      else router.push(`${pathname}/${toolViewSegment}${next}`, { scroll: false });
    },
    [pathname, router, search],
  );
  return { state, update };
}
