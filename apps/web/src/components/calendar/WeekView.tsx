'use client';

import { useMemo, useRef } from 'react';
import {
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  isSameDay,
  differenceInMinutes,
  setHours,
  setMinutes,
} from 'date-fns';
import { cn } from '@/lib/utils';
import {
  CalendarEvent,
  CalendarHandlers,
  TaskWithDueDate,
  getTasksForDay,
  isToday,
  getEventColors,
  TASK_OVERLAY_STYLE,
} from './calendar-types';

interface WeekViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 48; // pixels per hour

export function WeekView({ currentDate, events, tasks, handlers }: WeekViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Calculate the days of the current week
  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(currentDate);
    const weekEnd = endOfWeek(currentDate);
    return eachDayOfInterval({ start: weekStart, end: weekEnd });
  }, [currentDate]);

  // Separate all-day events from timed events
  const { allDayEvents, timedEvents } = useMemo(() => {
    const allDay: CalendarEvent[] = [];
    const timed: CalendarEvent[] = [];

    events.forEach((event) => {
      if (event.allDay) {
        allDay.push(event);
      } else {
        timed.push(event);
      }
    });

    return { allDayEvents: allDay, timedEvents: timed };
  }, [events]);

  // Handle click on time slot
  const handleTimeSlotClick = (day: Date, hour: number) => {
    const start = setMinutes(setHours(new Date(day), hour), 0);
    const end = setMinutes(setHours(new Date(day), hour + 1), 0);
    handlers.onEventCreate(start, end);
  };

  // Calculate event position and height
  const getEventStyle = (event: CalendarEvent, day: Date) => {
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);

    // Clamp to current day
    const dayStart = setMinutes(setHours(new Date(day), 0), 0);
    const dayEnd = setMinutes(setHours(new Date(day), 23), 59);

    const effectiveStart = start < dayStart ? dayStart : start;
    const effectiveEnd = end > dayEnd ? dayEnd : end;

    const startMinutes = effectiveStart.getHours() * 60 + effectiveStart.getMinutes();
    const durationMinutes = differenceInMinutes(effectiveEnd, effectiveStart);

    const top = (startMinutes / 60) * HOUR_HEIGHT;
    const height = Math.max((durationMinutes / 60) * HOUR_HEIGHT, 20); // Min 20px height

    return { top, height };
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with day names */}
      <div className="flex border-b bg-background sticky top-0 z-10">
        {/* Time gutter spacer */}
        <div className="w-16 shrink-0 border-r" />

        {/* Day columns header */}
        {weekDays.map((day) => {
          const isTodayDate = isToday(day);
          const dayAllDayEvents = allDayEvents.filter((e) => {
            const start = new Date(e.startAt);
            const end = new Date(e.endAt);
            return day >= start && day <= end;
          });
          const dayTasks = getTasksForDay(tasks, day);

          return (
            <div key={day.toISOString()} className="flex-1 border-r last:border-r-0">
              {/* Day header */}
              <button
                className={cn(
                  'w-full px-2 py-2 text-center hover:bg-muted/50 transition-colors',
                  isTodayDate && 'bg-primary/5'
                )}
                onClick={() => {
                  handlers.onDateChange(day);
                  handlers.onViewChange('day');
                }}
              >
                <div className="text-xs text-muted-foreground">
                  {format(day, 'EEE')}
                </div>
                <div
                  className={cn(
                    'text-lg font-semibold w-8 h-8 mx-auto flex items-center justify-center rounded-full',
                    isTodayDate && 'bg-primary text-primary-foreground'
                  )}
                >
                  {format(day, 'd')}
                </div>
              </button>

              {/* All-day events section */}
              {(dayAllDayEvents.length > 0 || dayTasks.length > 0) && (
                <div className="px-1 py-1 border-t bg-muted/20 space-y-0.5 max-h-20 overflow-y-auto">
                  {dayAllDayEvents.map((event) => (
                    <AllDayEventPill
                      key={event.id}
                      event={event}
                      onClick={() => handlers.onEventClick(event)}
                    />
                  ))}
                  {dayTasks.map((task) => (
                    <TaskPill
                      key={task.id}
                      task={task}
                      onClick={() => handlers.onTaskClick?.(task)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <div className="flex min-h-full">
          {/* Time gutter */}
          <div className="w-16 shrink-0 border-r">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="relative border-b"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="absolute -top-2.5 right-2 text-xs text-muted-foreground">
                  {format(setHours(new Date(), hour), 'h a')}
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          {weekDays.map((day) => {
            const dayTimedEvents = timedEvents.filter((e) => {
              const start = new Date(e.startAt);
              const end = new Date(e.endAt);
              return isSameDay(start, day) || isSameDay(end, day) || (start < day && end > day);
            });

            return (
              <div
                key={day.toISOString()}
                className="flex-1 border-r last:border-r-0 relative"
              >
                {/* Hour slots */}
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                    style={{ height: HOUR_HEIGHT }}
                    onClick={() => handleTimeSlotClick(day, hour)}
                  />
                ))}

                {/* Current time indicator */}
                {isToday(day) && <CurrentTimeIndicator />}

                {/* Timed events */}
                {dayTimedEvents.map((event) => {
                  const { top, height } = getEventStyle(event, day);
                  const colors = getEventColors(event.color);

                  return (
                    <button
                      key={event.id}
                      className={cn(
                        'absolute left-1 right-1 px-1.5 py-0.5 rounded text-xs overflow-hidden border-l-2',
                        colors.bg,
                        colors.border,
                        'hover:opacity-80 transition-opacity cursor-pointer text-left'
                      )}
                      style={{ top, height, minHeight: 20 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handlers.onEventClick(event);
                      }}
                    >
                      <div className="font-medium truncate">{event.title}</div>
                      {height > 30 && (
                        <div className="text-muted-foreground truncate">
                          {format(new Date(event.startAt), 'h:mm a')}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Current time indicator
function CurrentTimeIndicator() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const top = (minutes / 60) * HOUR_HEIGHT;

  return (
    <div
      className="absolute left-0 right-0 z-20 pointer-events-none"
      style={{ top }}
    >
      <div className="flex items-center">
        <div className="w-2 h-2 rounded-full bg-red-500" />
        <div className="flex-1 h-0.5 bg-red-500" />
      </div>
    </div>
  );
}

// All-day event pill
function AllDayEventPill({
  event,
  onClick,
}: {
  event: CalendarEvent;
  onClick: () => void;
}) {
  const colors = getEventColors(event.color);

  return (
    <button
      className={cn(
        'w-full text-left px-1.5 py-0.5 rounded text-xs truncate border-l-2',
        colors.bg,
        colors.border,
        'hover:opacity-80 transition-opacity'
      )}
      onClick={onClick}
    >
      {event.title}
    </button>
  );
}

// Task pill (muted styling)
function TaskPill({
  task,
  onClick,
}: {
  task: TaskWithDueDate;
  onClick: () => void;
}) {
  const isCompleted = task.status === 'completed';

  return (
    <button
      className={cn(
        'w-full text-left px-1.5 py-0.5 rounded text-xs truncate border-l-2',
        TASK_OVERLAY_STYLE.bg,
        TASK_OVERLAY_STYLE.border,
        TASK_OVERLAY_STYLE.opacity,
        isCompleted && 'line-through',
        'hover:opacity-100 transition-opacity'
      )}
      onClick={onClick}
    >
      <span className="mr-1">☐</span>
      {task.title}
    </button>
  );
}
