'use client';

import { useEffect, type ReactNode } from 'react';
import useSWR from 'swr';
import { differenceInMinutes, format } from 'date-fns';
import { useDriveStore } from '@/retained/hooks/useDrive';
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
const rowClass = 'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm text-ink-muted';

/**
 * The Calendar tool's pane (C-Drive-Calendar): the Event button, the October mini month, the
 * CALENDARS group (the drive, or on Home, the dashboard, Personal and every drive as the grid
 * shows them; then Google when it is connected and this is not on-prem) and the EVENT TYPES legend. The visible date is the URL's, so the middle follows the picker.
 */
export function CalendarPane({ driveId, close, allDrives = false }: ToolPaneProps & { readonly allDrives?: boolean }): ReactNode {
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

  return renderToolPane({
    title: 'Calendar',
    label: 'Calendars',
    actions: eventButton,
    close,
    children: (
      <>
        <MiniMonth date={state.date} onSelect={(date) => update({ date: formatCalendarDate(date) })} />
        <h3 className={groupHeadingClass}>CALENDARS</h3>
        <ul className="flex flex-col gap-px">
          {calendars.map((calendar) => (
            <li key={calendar.key} className={rowClass}>
              <span aria-hidden="true" className={`size-presence-dot flex-none rounded-sm ${calendar.dotClass}`} />
              <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
            </li>
          ))}
          {onPrem || connection === null ? null : (
            <li className={rowClass}>
              <span aria-hidden="true" className="size-presence-dot flex-none rounded-sm bg-accent-deep" />
              <span className="min-w-0 flex-1 truncate">{connection.googleEmail === null ? 'Google' : `Google · ${connection.googleEmail}`}</span>
              <span className="flex-none text-2xs text-ink-faint">{syncedLabel(connection.lastSyncAt, new Date())}</span>
            </li>
          )}
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
