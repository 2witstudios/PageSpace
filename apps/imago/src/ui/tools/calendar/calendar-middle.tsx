'use client';

import type { ReactNode } from 'react';
import { CalendarView, type EmbeddedCalendarState } from '@/retained/components/calendar/CalendarView';
import { CalendarToolbar } from './calendar-toolbar';
import { formatCalendarDate, stepCalendarDate } from './calendar-state';
import { useCalendarState } from './use-calendar-state';

export type CalendarMiddleProps = {
  readonly driveId: string;
};

/** The Calendar's middle (C-Drive-Calendar): the 44px week strip over the retained grid, driven by the URL. */
export function CalendarMiddle({ driveId }: CalendarMiddleProps): ReactNode {
  const { state, update } = useCalendarState();
  const embedded: EmbeddedCalendarState = {
    viewMode: state.view,
    currentDate: state.date,
    openEventId: state.eventId,
    composing: state.compose,
    onViewModeChange: (view) => update({ view }),
    onDateChange: (date) => update({ date: formatCalendarDate(date) }),
    onOpenEventChange: (eventId) => update({ eventId }),
    onComposingChange: (composing) => update({ compose: composing ? '1' : null }),
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CalendarToolbar
        view={state.view}
        date={state.date}
        onStep={(direction) => update({ date: formatCalendarDate(stepCalendarDate(state.view, state.date, direction)) })}
        onToday={() => update({ date: formatCalendarDate(new Date()) })}
        onView={(view) => update({ view })}
      />
      <div className="min-h-0 flex-1">
        <CalendarView embedded={embedded} context="drive" driveId={driveId} />
      </div>
    </div>
  );
}
