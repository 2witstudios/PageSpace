'use client';

import React, { memo } from 'react';
import { CalendarClock, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { dayKey, formatDayLabel, formatTime } from './calendar-utils';

export interface FreeSlot {
  start: string;
  end: string;
  durationMinutes?: number;
}

interface CalendarAvailabilityRendererProps {
  freeSlots: FreeSlot[];
  /** Whether more slots exist beyond the returned set. */
  hasMore?: boolean;
  /** IANA timezone used to format the slot times. */
  timezone?: string;
  maxHeight?: number;
  className?: string;
}

const formatDuration = (minutes?: number): string => {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
};

/**
 * CalendarAvailabilityRenderer - Free time slots from check_calendar_availability.
 */
export const CalendarAvailabilityRenderer: React.FC<CalendarAvailabilityRendererProps> = memo(
  function CalendarAvailabilityRenderer({ freeSlots, hasMore, timezone, maxHeight = 320, className }) {
    return (
      <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
        <div className="flex items-center justify-between px-3 py-2 bg-muted/30 border-b">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Availability</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {freeSlots.length}
            {hasMore ? '+' : ''} free {freeSlots.length === 1 ? 'slot' : 'slots'}
          </span>
        </div>

        <div className="bg-background overflow-auto divide-y divide-border" style={{ maxHeight: `${maxHeight}px` }}>
          {freeSlots.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-4">No free slots found</div>
          ) : (
            freeSlots.map((slot, i) => (
              <div key={`${slot.start}-${i}`} className="flex items-center gap-3 px-3 py-2">
                <div className="flex items-center justify-center w-7 h-7 rounded-md bg-emerald-500/10 shrink-0">
                  <Check className="h-4 w-4 text-emerald-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {formatDayLabel(slot.start, timezone)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatTime(slot.start, timezone)} – {formatTime(slot.end, timezone)}
                    {dayKey(slot.start, timezone) !== dayKey(slot.end, timezone) &&
                      ` (${formatDayLabel(slot.end, timezone)})`}
                  </div>
                </div>
                {formatDuration(slot.durationMinutes) && (
                  <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                    {formatDuration(slot.durationMinutes)}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    );
  }
);
