'use client';

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import useSWR from 'swr';
import { format } from 'date-fns';
import type { AttendeeStatus, CalendarEvent, CalendarEventAttendee } from '@/retained/components/calendar/calendar-types';
import { renderIcon } from '../../components/icon/icon.render';
import { fetchCalendarJson } from './calendar-fetch';

type AttendeesResponse = { readonly attendees: readonly CalendarEventAttendee[] };
type TriggerResponse = { readonly trigger: { readonly triggerAt: string } | null };

const statusLabels: Readonly<Record<AttendeeStatus, string>> = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  TENTATIVE: 'Tentative',
  DECLINED: 'Declined',
};

const visibilityLabels: Readonly<Record<CalendarEvent['visibility'], string>> = {
  DRIVE: 'Visible to drive',
  ATTENDEES_ONLY: 'Visible to attendees only',
  PRIVATE: 'Private',
};

/** "Tue, Oct 13 · 2:00 – 3:00 PM", or "All day". */
export function eventTimeLabel(event: Pick<CalendarEvent, 'startAt' | 'endAt' | 'allDay'>): string {
  if (event.allDay) return 'All day';
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  return `${format(start, 'EEE, MMM d')} · ${format(start, 'h:mm')} – ${format(end, 'h:mm a')}`;
}

/** How many minutes before the event its workflow fires; 0 means at its start. */
export function minutesBefore(startAt: string, triggerAt: string): number {
  return Math.round((Date.parse(startAt) - Date.parse(triggerAt)) / 60_000);
}

export function attendeeRoleLabel(attendee: Pick<CalendarEventAttendee, 'isOrganizer' | 'status'>): string {
  return attendee.isOrganizer ? 'Organizer' : statusLabels[attendee.status];
}

const rowClass = 'flex min-w-0 items-center gap-2 text-sm';
const actionClass =
  'flex h-8 cursor-pointer items-center rounded-md border border-hairline bg-transparent px-3 text-sm text-ink no-underline hover:bg-fill hover:no-underline';

export type EventPopoverProps = {
  readonly event: CalendarEvent;
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onGoing: () => Promise<void>;
};

/**
 * The event's popover (C-Drive-Calendar): time, place, linked page, attendees and triggers.
 * It names itself by the event title. When it closes, focus returns to what had it.
 */
export function EventPopover({ event, onClose, onEdit, onGoing }: EventPopoverProps): ReactNode {
  const attendees = useSWR<AttendeesResponse>(`/api/calendar/events/${event.id}/attendees`, (url: string) => fetchCalendarJson<AttendeesResponse>(url));
  const trigger = useSWR<TriggerResponse>(`/api/calendar/events/${event.id}/triggers`, (url: string) => fetchCalendarJson<TriggerResponse>(url));
  const [rsvpFailed, setRsvpFailed] = useState(false);

  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const list = attendees.data?.attendees ?? [];
  const replied = list.filter((attendee) => attendee.status !== 'PENDING').length;
  const triggerAt = trigger.data?.trigger?.triggerAt ?? null;
  const minutes = triggerAt === null ? null : minutesBefore(event.startAt, triggerAt);

  const onKeyDown = (key: KeyboardEvent<HTMLElement>) => {
    if (key.key === 'Escape') onClose();
  };

  const going = async () => {
    try {
      await onGoing();
      setRsvpFailed(false);
    } catch {
      setRsvpFailed(true);
    }
  };

  return (
    <section
      role="dialog"
      aria-label={event.title}
      onKeyDown={onKeyDown}
      className="absolute top-3 right-3 z-20 flex w-list-pane max-w-full flex-col gap-3 rounded-lg border border-hairline bg-background p-4 shadow-sheet"
    >
      <header className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{event.title}</h2>
        <button type="button" className="flex size-head-control flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-ink-muted hover:bg-fill hover:text-ink" aria-label="Close event" title="Close event" onClick={onClose}>
          {renderIcon({ name: 'close', size: 12 })}
        </button>
      </header>
      <p className="text-sm text-ink-muted">{eventTimeLabel(event)}</p>
      {event.location ? <p className="text-sm text-ink">{event.location}</p> : null}
      {event.page ? <p className="text-sm text-ink-muted">{`Linked page: ${event.page.title}`}</p> : null}
      <p className="text-2xs text-ink-faint">{visibilityLabels[event.visibility]}</p>

      <section aria-label="Attendees" className="flex flex-col gap-1">
        {attendees.error ? (
          <p className="text-sm text-status-danger">Attendees could not load</p>
        ) : (
          <>
            <h3 className="text-2xs font-semibold tracking-wide text-ink-faint uppercase">{`Attendees · ${replied} of ${list.length} replied`}</h3>
            <ul className="flex flex-col gap-1">
              {list.map((attendee) => (
                <li key={attendee.id} className={rowClass}>
                  <span className="min-w-0 flex-1 truncate text-ink">{attendee.user.name ?? 'Unnamed'}</span>
                  <span className="flex-none text-2xs text-ink-muted">{attendeeRoleLabel(attendee)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {minutes === null ? null : (
        <p className="text-sm text-ink-muted">{minutes > 0 ? `Runs workflow ${minutes} min before` : 'Runs workflow at start'}</p>
      )}

      <footer className="flex items-center gap-2">
        <button type="button" className={actionClass} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className={actionClass} onClick={() => void going()}>
          Going
        </button>
        {rsvpFailed ? <span className="text-2xs text-status-danger">RSVP failed</span> : null}
      </footer>
    </section>
  );
}
