'use client';

import { useMemo, useRef } from 'react';
import {
  format,
  differenceInMinutes,
  setHours,
  setMinutes,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { MapPin, Users } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  CalendarEvent,
  CalendarHandlers,
  TaskWithDueDate,
  getEventsForDay,
  getTasksForDay,
  isToday,
  getEventColors,
  TASK_OVERLAY_STYLE,
} from './calendar-types';

interface DayViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT = 64; // Taller for day view

export function DayView({ currentDate, events, tasks, handlers }: DayViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Get events and tasks for the current day
  const dayEvents = useMemo(() => getEventsForDay(events, currentDate), [events, currentDate]);
  const dayTasks = useMemo(() => getTasksForDay(tasks, currentDate), [tasks, currentDate]);

  // Separate all-day events from timed events
  const { allDayEvents, timedEvents } = useMemo(() => {
    const allDay: CalendarEvent[] = [];
    const timed: CalendarEvent[] = [];

    dayEvents.forEach((event) => {
      if (event.allDay) {
        allDay.push(event);
      } else {
        timed.push(event);
      }
    });

    return { allDayEvents: allDay, timedEvents: timed };
  }, [dayEvents]);

  // Handle click on time slot
  const handleTimeSlotClick = (hour: number) => {
    const start = setMinutes(setHours(new Date(currentDate), hour), 0);
    const end = setMinutes(setHours(new Date(currentDate), hour + 1), 0);
    handlers.onEventCreate(start, end);
  };

  // Calculate event position and height
  const getEventStyle = (event: CalendarEvent) => {
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);

    // Clamp to current day
    const dayStart = setMinutes(setHours(new Date(currentDate), 0), 0);
    const dayEnd = setMinutes(setHours(new Date(currentDate), 23), 59);

    const effectiveStart = start < dayStart ? dayStart : start;
    const effectiveEnd = end > dayEnd ? dayEnd : end;

    const startMinutes = effectiveStart.getHours() * 60 + effectiveStart.getMinutes();
    const durationMinutes = differenceInMinutes(effectiveEnd, effectiveStart);

    const top = (startMinutes / 60) * HOUR_HEIGHT;
    const height = Math.max((durationMinutes / 60) * HOUR_HEIGHT, 40); // Min 40px height

    return { top, height };
  };

  const isTodayDate = isToday(currentDate);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Day header */}
      <div className="border-b bg-background px-4 py-3">
        <div className="flex items-center gap-4">
          <div
            className={cn(
              'w-12 h-12 flex items-center justify-center rounded-full text-xl font-bold',
              isTodayDate ? 'bg-primary text-primary-foreground' : 'bg-muted'
            )}
          >
            {format(currentDate, 'd')}
          </div>
          <div>
            <div className="font-semibold">{format(currentDate, 'EEEE')}</div>
            <div className="text-sm text-muted-foreground">
              {format(currentDate, 'MMMM yyyy')}
            </div>
          </div>
        </div>

        {/* All-day events and tasks */}
        {(allDayEvents.length > 0 || dayTasks.length > 0) && (
          <div className="mt-3 space-y-1">
            <div className="text-xs font-medium text-muted-foreground mb-1">
              All Day
            </div>
            {allDayEvents.map((event) => (
              <AllDayEventCard
                key={event.id}
                event={event}
                onClick={() => handlers.onEventClick(event)}
              />
            ))}
            {dayTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={() => handlers.onTaskClick?.(task)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Time grid */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <div className="flex min-h-full">
          {/* Time gutter */}
          <div className="w-20 shrink-0 border-r">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="relative border-b"
                style={{ height: HOUR_HEIGHT }}
              >
                <span className="absolute -top-2.5 right-3 text-xs text-muted-foreground">
                  {format(setHours(new Date(), hour), 'h a')}
                </span>
              </div>
            ))}
          </div>

          {/* Events column */}
          <div className="flex-1 relative">
            {/* Hour slots */}
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                style={{ height: HOUR_HEIGHT }}
                onClick={() => handleTimeSlotClick(hour)}
              />
            ))}

            {/* Current time indicator */}
            {isTodayDate && <CurrentTimeIndicator />}

            {/* Timed events */}
            {timedEvents.map((event) => {
              const { top, height } = getEventStyle(event);

              return (
                <TimedEventCard
                  key={event.id}
                  event={event}
                  style={{ top, height }}
                  onClick={() => handlers.onEventClick(event)}
                />
              );
            })}
          </div>
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
        <div className="w-3 h-3 rounded-full bg-red-500 -ml-1.5" />
        <div className="flex-1 h-0.5 bg-red-500" />
      </div>
    </div>
  );
}

// Timed event card (expanded)
function TimedEventCard({
  event,
  style,
  onClick,
}: {
  event: CalendarEvent;
  style: { top: number; height: number };
  onClick: () => void;
}) {
  const colors = getEventColors(event.color);
  const showDetails = style.height > 60;

  return (
    <button
      className={cn(
        'absolute left-2 right-2 px-3 py-2 rounded-lg text-left border-l-4 overflow-hidden',
        colors.bg,
        colors.border,
        'hover:shadow-md transition-shadow cursor-pointer'
      )}
      style={{ top: style.top, height: style.height, minHeight: 40 }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <div className="font-medium truncate">{event.title}</div>
      <div className="text-xs text-muted-foreground">
        {format(new Date(event.startAt), 'h:mm a')} - {format(new Date(event.endAt), 'h:mm a')}
      </div>

      {showDetails && event.location && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
          <MapPin className="w-3 h-3" />
          <span className="truncate">{event.location}</span>
        </div>
      )}

      {showDetails && event.attendees.length > 0 && (
        <div className="flex items-center gap-1 mt-2">
          <Users className="w-3 h-3 text-muted-foreground" />
          <div className="flex -space-x-1">
            {event.attendees.slice(0, 3).map((attendee) => (
              <Avatar key={attendee.id} className="w-5 h-5 border-2 border-background">
                <AvatarImage src={attendee.user.image ?? undefined} />
                <AvatarFallback className="text-[8px]">
                  {attendee.user.name?.charAt(0) ?? '?'}
                </AvatarFallback>
              </Avatar>
            ))}
            {event.attendees.length > 3 && (
              <span className="text-xs text-muted-foreground ml-1">
                +{event.attendees.length - 3}
              </span>
            )}
          </div>
        </div>
      )}
    </button>
  );
}

// All-day event card
function AllDayEventCard({
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
        'w-full text-left px-3 py-2 rounded-lg border-l-4',
        colors.bg,
        colors.border,
        'hover:opacity-80 transition-opacity'
      )}
      onClick={onClick}
    >
      <div className="font-medium">{event.title}</div>
      {event.location && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="w-3 h-3" />
          <span className="truncate">{event.location}</span>
        </div>
      )}
    </button>
  );
}

// Task card
function TaskCard({
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
        'w-full text-left px-3 py-2 rounded-lg border-l-4',
        TASK_OVERLAY_STYLE.bg,
        TASK_OVERLAY_STYLE.border,
        TASK_OVERLAY_STYLE.opacity,
        isCompleted && 'line-through',
        'hover:opacity-100 transition-opacity'
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        <span>☐</span>
        <span className="font-medium">{task.title}</span>
      </div>
    </button>
  );
}
