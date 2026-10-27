'use client';

import type { ReactNode } from 'react';
import { CalendarView, type EmbeddedCalendarState } from '@/retained/components/calendar/CalendarView';
import { useCalendarFilterStore } from '@/retained/stores/useCalendarFilterStore';
import { formatCalendarDate, stepCalendarDate } from '../calendar/calendar-state';
import { useCalendarState } from '../calendar/use-calendar-state';
import { UserCalendarToolbar } from './user-calendar-toolbar';

/**
 * The user calendar's middle (C-Account-Calendar): the 44px toolbar and the shared grid for every
 * drive the user sees, in the user context. The visible date and view live in the URL, as they do
 * for the drive calendar; the calendar, event-type and tasks filters are the Calendar pane's,
 * in the shared calendar filter store, so the grid follows the pane.
 */
export function UserCalendarMiddle(): ReactNode {
  const { state, update } = useCalendarState();
  const showTasks = useCalendarFilterStore((store) => store.showTasks);
  const toggleTasks = useCalendarFilterStore((store) => store.toggleTasks);

  const embedded: EmbeddedCalendarState = {
    viewMode: state.view,
    currentDate: state.date,
    openEventId: state.eventId,
    composing: state.compose,
    showTasks,
    onShowTasksChange: (shown) => {
      if (shown !== showTasks) toggleTasks();
    },
    onViewModeChange: (view) => update({ view }),
    onDateChange: (date) => update({ date: formatCalendarDate(date) }),
    onOpenEventChange: (eventId) => update({ eventId }),
    onComposingChange: (composing) => update({ compose: composing ? '1' : null }),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <UserCalendarToolbar
        view={state.view}
        date={state.date}
        onStep={(direction) => update({ date: formatCalendarDate(stepCalendarDate(state.view, state.date, direction)) })}
        onToday={() => update({ date: formatCalendarDate(new Date()) })}
        onView={(view) => update({ view })}
        onNewEvent={() => update({ compose: '1' })}
      />
      <div className="min-h-0 flex-1">
        <CalendarView embedded={embedded} context="user" />
      </div>
    </div>
  );
}
