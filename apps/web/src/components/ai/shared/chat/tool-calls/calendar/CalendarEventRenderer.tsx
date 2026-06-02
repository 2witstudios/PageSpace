'use client';

import React, { memo } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarDays,
  Clock,
  MapPin,
  Repeat,
  Users,
  Lock,
  Bot,
  CheckCircle,
  ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { calendarEventHref, eventColorDot, formatEventRange, rsvpColor } from './calendar-utils';

export interface CalendarEventAttendee {
  userId?: string;
  name?: string | null;
  status?: string;
  isOrganizer?: boolean;
  isOptional?: boolean;
}

export interface CalendarEventData {
  id?: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
  timezone?: string;
  visibility?: string;
  color?: string | null;
  recurrenceRule?: unknown;
  driveId?: string | null;
  attendees?: CalendarEventAttendee[];
  scheduledWork?: { triggerId: string; status: string } | null;
}

interface CalendarEventRendererProps {
  event: CalendarEventData;
  /** Header chip label, e.g. "Created" or "Updated". Omit for a plain event card. */
  actionLabel?: string;
  className?: string;
}

const VISIBILITY_LABEL: Record<string, string> = {
  DRIVE: 'Workspace',
  ATTENDEES_ONLY: 'Attendees only',
  PRIVATE: 'Private',
};

/**
 * CalendarEventRenderer - A single calendar event card.
 *
 * Used for get_calendar_event, create_calendar_event and update_calendar_event.
 * Renders time, location, recurrence, visibility, attendees and any scheduled
 * agent work attached to the event.
 */
export const CalendarEventRenderer: React.FC<CalendarEventRendererProps> = memo(function CalendarEventRenderer({
  event,
  actionLabel,
  className,
}) {
  const router = useRouter();
  const range = formatEventRange(event.startAt, event.endAt, event.allDay, event.timezone);
  const attendees = event.attendees ?? [];
  const recurring = Boolean(event.recurrenceRule);
  const href = calendarEventHref(event);

  return (
    <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
      {/* Header — opens the event in the calendar */}
      <button
        type="button"
        onClick={() => href && router.push(href)}
        disabled={!href}
        className={cn(
          'w-full flex items-center justify-between gap-2 px-3 py-2 bg-muted/30 border-b text-left',
          href ? 'hover:bg-muted/50 transition-colors cursor-pointer group' : 'cursor-default'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate" title={event.title}>
            {event.title || 'Event'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actionLabel && (
            <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">
              <CheckCircle className="h-3 w-3" />
              {actionLabel}
            </span>
          )}
          {href && (
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </div>
      </button>

      {/* Body */}
      <div className="p-3 space-y-2">
        {range && (
          <div className="flex items-center gap-2 text-sm">
            <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', eventColorDot(event.color))} />
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="truncate">{range}</span>
            {recurring && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Repeat className="h-3 w-3" />
                Repeats
              </span>
            )}
          </div>
        )}

        {event.location && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{event.location}</span>
          </div>
        )}

        {event.description && (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">
            {event.description}
          </p>
        )}

        <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground pt-0.5">
          {event.visibility && (
            <span className="flex items-center gap-1">
              <Lock className="h-3 w-3" />
              {VISIBILITY_LABEL[event.visibility] ?? event.visibility}
            </span>
          )}
          {attendees.length > 0 && (
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {attendees.length} {attendees.length === 1 ? 'attendee' : 'attendees'}
            </span>
          )}
          {event.scheduledWork && (
            <span className="flex items-center gap-1 text-violet-600 dark:text-violet-400">
              <Bot className="h-3 w-3" />
              Agent {event.scheduledWork.status}
            </span>
          )}
        </div>

        {/* Attendee list */}
        {attendees.length > 0 && (
          <div className="border-t pt-2 mt-1 space-y-1">
            {attendees.slice(0, 8).map((a, i) => (
              <div key={a.userId ?? i} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">
                  {a.name || 'Unknown'}
                  {a.isOrganizer && (
                    <span className="ml-1.5 text-muted-foreground">· organizer</span>
                  )}
                  {a.isOptional && <span className="ml-1.5 text-muted-foreground">· optional</span>}
                </span>
                {a.status && (
                  <span className={cn('shrink-0 capitalize', rsvpColor(a.status))}>
                    {a.status.toLowerCase()}
                  </span>
                )}
              </div>
            ))}
            {attendees.length > 8 && (
              <div className="text-xs text-muted-foreground">+{attendees.length - 8} more</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
