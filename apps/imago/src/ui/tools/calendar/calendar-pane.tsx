'use client';

import { useEffect, type ReactNode } from 'react';
import useSWR from 'swr';
import { differenceInMinutes, format } from 'date-fns';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useCalendarFilterStore } from '@/retained/stores/useCalendarFilterStore';
import { useHydrated } from '../../frame/shell/use-hydrated';
import { isOnPrem } from '@/retained/lib/deployment-mode';
import { getDriveCalendarColor, getEventColors } from '@/retained/components/calendar/calendar-types';
import { renderIcon } from '../../components/icon/icon.render';
import { renderToolPane, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import { calendarEventTypes } from './calendar-event-types';
import { fetchCalendarJson } from './calendar-fetch';
import { formatCalendarDate } from './calendar-state';
import { MiniMonth } from './mini-month';
import { useCalendarState } from './use-calendar-state';
import { userCalendars, type UserCalendar } from '../user-calendar/user-calendars';

export type GoogleCalendarStatus = {
  readonly connected: boolean;
  readonly connection: { readonly googleEmail: string | null; readonly lastSyncAt: string | null } | null;
};

const googleStatusUrl = '/api/integrations/google-calendar/status';

/** "synced 4 min ago", from the connection's last sync. */
export function syncedLabel(lastSyncAt: string | null, now: Date): string {
  if (lastSyncAt === null) return 'not synced yet';
  const last = new Date(lastSyncAt);
  const minutes = differenceInMinutes(now, last);
  if (minutes < 1) return 'synced just now';
  if (minutes < 60) return `synced ${minutes} min ago`;
  if (minutes < 24 * 60) return `synced ${Math.floor(minutes / 60)} hr ago`;
  return `synced ${format(last, 'MMM d')}`;
}

const groupHeadingClass = 'px-1.5 pt-3 pb-1 text-2xs font-semibold tracking-wide text-ink-faint';
const groupHeadRowClass = 'flex items-center justify-between pr-1.5';
const rowClass = 'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm text-ink-muted';
const toggleRowClass = (on: boolean): string =>
  `flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 text-left text-sm hover:bg-fill ${on ? 'text-ink' : 'text-ink-faint'}`;
const showAllClass = 'cursor-pointer border-0 bg-transparent p-0 text-2xs font-medium text-ink-faint hover:text-ink';

/** A filter row (classic's calendar sidebar): a checkbox in the row's colour, its name, then anything trailing. */
function FilterRow({ label, dotClass, on, onToggle, trailing }: {
  readonly label: string;
  readonly dotClass: string;
  readonly on: boolean;
  readonly onToggle: () => void;
  readonly trailing?: ReactNode;
}): ReactNode {
  return (
    <li>
      <button type="button" role="checkbox" aria-checked={on} onClick={onToggle} className={toggleRowClass(on)}>
        <span
          aria-hidden="true"
          className={`flex size-checkbox flex-none items-center justify-center rounded-sm border ${on ? `${dotClass} border-transparent text-spine-on` : 'border-hairline bg-transparent'}`}
        >
          {on ? renderIcon({ name: 'check', size: 10 }) : null}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </button>
    </li>
  );
}

/**
 * The Calendar tool's pane (C-Drive-Calendar), the calendar's filter as classic had it: the Event
 * button and the mini month, then what the grid shows. On Home, the dashboard, each calendar
 * (Personal and every drive) can be shown or hidden; then Google when it is connected and this is
 * not on-prem; then user events, agent events and tasks. The filters live in the shared calendar
 * filter store, so the grid follows the pane. Picking a date or Event opens the calendar's screen.
 */
export function CalendarPane({ driveId, close, variant, scope: scopeSwitch = null, allDrives = false }: ToolPaneProps & { readonly allDrives?: boolean }): ReactNode {
  const { state, update } = useCalendarState();
  const drives = useDriveStore((store) => store.drives);
  const drive = drives.find((entry) => entry.id === driveId);
  const calendars: readonly UserCalendar[] = allDrives
    ? userCalendars(drives)
    : drive === undefined
      ? []
      : [{ key: drive.id, name: drive.name, dotClass: getDriveCalendarColor(drive.id, [drive.id]).dot }];
  const fetchDrives = useDriveStore((store) => store.fetchDrives);
  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  const onPrem = isOnPrem();
  const google = useSWR<GoogleCalendarStatus>(onPrem ? null : googleStatusUrl, (url: string) => fetchCalendarJson<GoogleCalendarStatus>(url));
  const connection = google.data?.connected ? google.data.connection : null;

  const eventButton = (
    <button
      type="button"
      className="flex h-ask-pill cursor-pointer items-center gap-1 rounded-round border-0 bg-spine px-3 text-sm font-medium text-spine-on no-underline hover:no-underline"
      onClick={() => update({ compose: '1' })}
    >
      {renderIcon({ name: 'plus', size: 12 })}
      Event
    </button>
  );

  // The filters persist in this browser, which the server cannot read: until hydration the rows
  // draw the store's defaults, as the server did, so a saved filter never leaves a box mismatched.
  const hydrated = useHydrated();
  const storedHiddenCalendars = useCalendarFilterStore((store) => store.hiddenCalendars);
  const storedHiddenEventTypes = useCalendarFilterStore((store) => store.hiddenEventTypes);
  const storedShowTasks = useCalendarFilterStore((store) => store.showTasks);
  const hiddenCalendars = hydrated ? storedHiddenCalendars : [];
  const hiddenEventTypes = hydrated ? storedHiddenEventTypes : [];
  const showTasks = hydrated ? storedShowTasks : true;
  const toggleCalendar = useCalendarFilterStore((store) => store.toggleCalendar);
  const toggleEventType = useCalendarFilterStore((store) => store.toggleEventType);
  const toggleTasks = useCalendarFilterStore((store) => store.toggleTasks);
  const showAll = useCalendarFilterStore((store) => store.showAll);
  const hideAll = useCalendarFilterStore((store) => store.hideAll);
  const allVisible = calendars.every((calendar) => !hiddenCalendars.includes(calendar.key));

  return renderToolPane({
    title: 'Calendar',
    label: 'Calendars',
    actions: eventButton,
    close,
    scope: scopeSwitch,
    variant,
    children: (
      <>
        <MiniMonth date={state.date} onSelect={(date) => update({ date: formatCalendarDate(date) })} />
        {/* Show/Hide all sits beside the heading, not in it, so the heading reads "CALENDARS" alone. */}
        <div className={groupHeadRowClass}>
          <h3 className={groupHeadingClass}>CALENDARS</h3>
          {allDrives && calendars.length > 1 ? (
            <button type="button" className={showAllClass} onClick={() => (allVisible ? hideAll(calendars.map((calendar) => calendar.key)) : showAll())}>
              {allVisible ? 'Hide all' : 'Show all'}
            </button>
          ) : null}
        </div>
        <ul className="flex flex-col gap-px">
          {calendars.map((calendar) =>
            allDrives ? (
              <FilterRow
                key={calendar.key}
                label={calendar.name}
                dotClass={calendar.dotClass}
                on={!hiddenCalendars.includes(calendar.key)}
                onToggle={() => toggleCalendar(calendar.key)}
              />
            ) : (
              <li key={calendar.key} className={rowClass}>
                <span aria-hidden="true" className={`size-presence-dot flex-none rounded-sm ${calendar.dotClass}`} />
                <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
              </li>
            ),
          )}
          {onPrem || connection === null ? null : (
            <li className={rowClass}>
              <span aria-hidden="true" className="size-presence-dot flex-none rounded-sm bg-accent-deep" />
              <span className="min-w-0 flex-1 truncate">{connection.googleEmail === null ? 'Google' : `Google · ${connection.googleEmail}`}</span>
              <span className="flex-none text-2xs text-ink-faint">{syncedLabel(connection.lastSyncAt, new Date())}</span>
            </li>
          )}
        </ul>
        <h3 className={groupHeadingClass}>SHOW</h3>
        <ul className="flex flex-col gap-px">
          <FilterRow label="User events" dotClass="bg-accent" on={!hiddenEventTypes.includes('user')} onToggle={() => toggleEventType('user')} />
          <FilterRow label="Agent events" dotClass="bg-accent" on={!hiddenEventTypes.includes('agent')} onToggle={() => toggleEventType('agent')} />
          <FilterRow label="Tasks" dotClass="bg-accent" on={showTasks} onToggle={toggleTasks} />
        </ul>
        <h3 className={groupHeadingClass}>EVENT TYPES</h3>
        <ul className="flex flex-col gap-px">
          {calendarEventTypes.map((type) => (
            <li key={type.key} className={rowClass}>
              <span aria-hidden="true" className={`size-presence-dot flex-none rounded-sm ${getEventColors(type.key).dot}`} />
              <span className="min-w-0 flex-1 truncate">{type.label}</span>
            </li>
          ))}
        </ul>
      </>
    ),
  });
}
