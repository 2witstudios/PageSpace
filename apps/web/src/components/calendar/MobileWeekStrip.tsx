'use client';

import { useMemo } from 'react';
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  isSameMonth,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import {
  CalendarEvent,
  TaskWithDueDate,
  EventColorConfig,
  getEventsForDay,
  getTasksForDay,
  isSameDay,
  isToday,
  resolveEventColor,
} from './calendar-types';

interface MobileWeekStripProps {
  selectedDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  onDateSelect: (date: Date) => void;
  /** True while the strip is pulled down into a full month grid. */
  expanded: boolean;
  onToggleExpanded: () => void;
  driveColorMap?: Map<string | null, EventColorConfig> | null;
  context?: 'user' | 'drive';
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * A week of date pills that pulls down into the month grid. Month is a state of
 * this strip rather than a separate view, so it navigates the same agenda
 * instead of owning a second layout.
 */
export function MobileWeekStrip({
  selectedDate,
  events,
  tasks,
  onDateSelect,
  expanded,
  onToggleExpanded,
  driveColorMap,
  context = 'drive',
}: MobileWeekStripProps) {
  const visibleDays = useMemo(() => {
    if (expanded) {
      return eachDayOfInterval({
        start: startOfWeek(startOfMonth(selectedDate)),
        end: endOfWeek(endOfMonth(selectedDate)),
      });
    }
    return eachDayOfInterval({
      start: startOfWeek(selectedDate),
      end: endOfWeek(selectedDate),
    });
  }, [expanded, selectedDate]);

  return (
    <div className="flex-none bg-background border-b">
      <div
        className={cn(
          'grid grid-cols-7 px-2',
          expanded ? 'gap-y-0.5 pb-1' : 'pb-2'
        )}
      >
        {expanded &&
          WEEKDAY_LABELS.map((label, index) => (
            <span
              key={`head-${index}`}
              className="pb-1 text-center text-[10px] font-semibold tracking-wider text-muted-foreground"
            >
              {label}
            </span>
          ))}

        {visibleDays.map((day, index) => {
          const dayEvents = getEventsForDay(events, day);
          const dayTasks = getTasksForDay(tasks, day);
          const isTodayDate = isToday(day);
          const isSelected = isSameDay(day, selectedDate);
          const outsideMonth = expanded && !isSameMonth(day, selectedDate);
          const primaryEventColor =
            dayEvents.length > 0
              ? resolveEventColor(dayEvents[0], context, driveColorMap ?? null).dot
              : null;

          return (
            <button
              key={day.toISOString()}
              onClick={() => onDateSelect(day)}
              aria-current={isSelected ? 'date' : undefined}
              // The visible label is a bare number; say which date it is.
              aria-label={format(day, 'EEEE, MMMM d')}
              className="flex flex-col items-center gap-0.5 rounded-lg py-1"
            >
              {!expanded && (
                <span
                  className={cn(
                    'text-[10px] font-semibold tracking-wider',
                    isSelected ? 'text-primary' : 'text-muted-foreground'
                  )}
                >
                  {WEEKDAY_LABELS[index % 7]}
                </span>
              )}
              <span
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold tabular-nums transition-colors',
                  isSelected && 'bg-primary text-primary-foreground',
                  !isSelected && isTodayDate && 'text-primary font-bold',
                  outsideMonth && !isSelected && 'text-muted-foreground/50'
                )}
              >
                {format(day, 'd')}
              </span>
              <span className="flex h-1.5 items-center gap-0.5">
                {dayEvents.length > 0 && (
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      isSelected ? 'bg-primary-foreground/70' : primaryEventColor
                    )}
                  />
                )}
                {dayTasks.length > 0 && (
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      isSelected ? 'bg-primary-foreground/50' : 'bg-muted-foreground/50'
                    )}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>

      <button
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse to week' : 'Expand to month'}
        className="flex w-full items-center justify-center py-1 text-muted-foreground active:bg-muted/50"
      >
        <ChevronDown
          className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
