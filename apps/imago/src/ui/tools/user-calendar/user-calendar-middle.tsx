'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { CalendarView, type EmbeddedCalendarState } from '@/retained/components/calendar/CalendarView';
import { getDriveCalendarColor } from '@/retained/components/calendar/calendar-types';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useCalendarFilterStore } from '@/retained/stores/useCalendarFilterStore';
import { formatCalendarDate, stepCalendarDate } from '../calendar/calendar-state';
import { useCalendarState } from '../calendar/use-calendar-state';
import { UserCalendarChips, type UserCalendarChip } from './user-calendar-chips';
import { UserCalendarToolbar } from './user-calendar-toolbar';

/**
 * The user calendar's middle (C-Account-Calendar): the 44px toolbar, the calendar chips and the
 * shared grid for every drive the user sees, in the user context. The visible date and view live
 * in the URL, as they do for the drive calendar; the calendar and event-type filters live in the
 * shared calendar filter store, so the grid and these chips always agree.
 */
export function UserCalendarMiddle(): ReactNode {
  const { state, update } = useCalendarState();
  const drives = useDriveStore((store) => store.drives);
  const hiddenCalendars = useCalendarFilterStore((store) => store.hiddenCalendars);
  const hiddenEventTypes = useCalendarFilterStore((store) => store.hiddenEventTypes);
  const toggleCalendar = useCalendarFilterStore((store) => store.toggleCalendar);
  const toggleEventType = useCalendarFilterStore((store) => store.toggleEventType);
  const [showTasks, setShowTasks] = useState(true);

  const calendars = useMemo<UserCalendarChip[]>(() => {
    const driveIds = drives.map((drive) => drive.id);
    const personal = { key: 'personal', name: 'Personal', dotClass: getDriveCalendarColor(null, driveIds).dot };
    const perDrive = drives.map((drive) => ({
      key: drive.id,
      name: drive.name,
      dotClass: getDriveCalendarColor(drive.id, driveIds).dot,
    }));
    return [personal, ...perDrive].map((calendar) => ({
      ...calendar,
      visible: !hiddenCalendars.includes(calendar.key),
    }));
  }, [drives, hiddenCalendars]);

  const embedded: EmbeddedCalendarState = {
    viewMode: state.view,
    currentDate: state.date,
    openEventId: state.eventId,
    composing: state.compose,
    showTasks,
    onShowTasksChange: setShowTasks,
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
      <UserCalendarChips
        calendars={calendars}
        onToggleCalendar={toggleCalendar}
        userEventsVisible={!hiddenEventTypes.includes('user')}
        agentEventsVisible={!hiddenEventTypes.includes('agent')}
        onToggleUserEvents={() => toggleEventType('user')}
        onToggleAgentEvents={() => toggleEventType('agent')}
        showTasks={showTasks}
        onToggleTasks={() => setShowTasks((shown) => !shown)}
      />
      <div className="min-h-0 flex-1">
        <CalendarView embedded={embedded} context="user" />
      </div>
    </div>
  );
}
