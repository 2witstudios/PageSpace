'use client';

import React, { memo, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, MapPin, Users, Repeat } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  calendarEventHref,
  dayKey,
  eventColorDot,
  formatDayLabel,
  formatTime,
} from './calendar-utils';
import type { CalendarEventData } from './CalendarEventRenderer';

interface CalendarEventListRendererProps {
  events: CalendarEventData[];
  title?: string;
  maxHeight?: number;
  className?: string;
}

/**
 * CalendarEventListRenderer - An agenda view for list_calendar_events.
 *
 * Groups events by day (in each event's timezone) and renders compact rows with
 * time, title, location and attendee count.
 */
export const CalendarEventListRenderer: React.FC<CalendarEventListRendererProps> = memo(
  function CalendarEventListRenderer({ events, title = 'Calendar', maxHeight = 360, className }) {
    const router = useRouter();
    const groups = useMemo(() => {
      const sorted = [...events].sort((a, b) => {
        const ta = a.startAt ? new Date(a.startAt).getTime() : 0;
        const tb = b.startAt ? new Date(b.startAt).getTime() : 0;
        return ta - tb;
      });
      const map = new Map<string, { label: string; items: CalendarEventData[] }>();
      for (const e of sorted) {
        const key = dayKey(e.startAt, e.timezone);
        if (!map.has(key)) {
          map.set(key, { label: formatDayLabel(e.startAt, e.timezone) || 'Undated', items: [] });
        }
        map.get(key)!.items.push(e);
      }
      return Array.from(map.values());
    }, [events]);

    return (
      <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
        <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{title}</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {events.length} {events.length === 1 ? 'event' : 'events'}
          </span>
        </div>

        <div className="bg-background overflow-auto" style={{ maxHeight: `${maxHeight}px` }}>
          {events.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">No events in this range</div>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted/20 sticky top-0">
                  {group.label}
                </div>
                <div className="divide-y divide-border">
                  {group.items.map((e, i) => {
                    const href = calendarEventHref(e);
                    return (
                    <button
                      key={e.id ?? i}
                      type="button"
                      onClick={() => href && router.push(href)}
                      disabled={!href}
                      className={cn(
                        'w-full flex items-start gap-3 px-3 py-2 text-left',
                        href ? 'hover:bg-muted/50 transition-colors cursor-pointer' : 'cursor-default'
                      )}
                    >
                      <span
                        className={cn('mt-1.5 h-2.5 w-2.5 rounded-full shrink-0', eventColorDot(e.color))}
                      />
                      <div className="w-20 shrink-0 text-xs text-muted-foreground pt-0.5">
                        {e.allDay ? 'All day' : formatTime(e.startAt, e.timezone)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate">{e.title || 'Untitled'}</span>
                          {Boolean(e.recurrenceRule) && (
                            <Repeat className="h-3 w-3 text-muted-foreground shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                          {e.location && (
                            <span className="flex items-center gap-1 truncate">
                              <MapPin className="h-3 w-3 shrink-0" />
                              <span className="truncate">{e.location}</span>
                            </span>
                          )}
                          {e.attendees && e.attendees.length > 0 && (
                            <span className="flex items-center gap-1 shrink-0">
                              <Users className="h-3 w-3" />
                              {e.attendees.length}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }
);
