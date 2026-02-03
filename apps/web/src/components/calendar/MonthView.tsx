'use client';

import { useMemo } from 'react';
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  isSameMonth,
} from 'date-fns';
import { cn } from '@/lib/utils';
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

interface MonthViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_VISIBLE_EVENTS = 3;

export function MonthView({ currentDate, events, tasks, handlers }: MonthViewProps) {
  // Calculate the days to display
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const calendarStart = startOfWeek(monthStart);
    const calendarEnd = endOfWeek(monthEnd);

    return eachDayOfInterval({ start: calendarStart, end: calendarEnd });
  }, [currentDate]);

  // Group days into weeks
  const weeks = useMemo(() => {
    const result: Date[][] = [];
    for (let i = 0; i < calendarDays.length; i += 7) {
      result.push(calendarDays.slice(i, i + 7));
    }
    return result;
  }, [calendarDays]);

  // Handle cell click for creating events
  const handleCellClick = (day: Date) => {
    const start = new Date(day);
    start.setHours(9, 0, 0, 0);
    const end = new Date(day);
    end.setHours(10, 0, 0, 0);
    handlers.onEventCreate(start, end, true);
  };

  // Handle day number click for navigation
  const handleDayClick = (day: Date, e: React.MouseEvent) => {
    e.stopPropagation();
    handlers.onDateChange(day);
    handlers.onViewChange('day');
  };

  return (
    <div className="flex flex-col h-full">
      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b bg-muted/30">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="px-2 py-2 text-center text-sm font-medium text-muted-foreground"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="flex-1 flex flex-col overflow-auto">
        {weeks.map((week, weekIndex) => (
          <div key={weekIndex} className="flex-1 min-h-24 grid grid-cols-7 border-b last:border-b-0">
            {week.map((day) => {
              const dayEvents = getEventsForDay(events, day);
              const dayTasks = getTasksForDay(tasks, day);
              const isCurrentMonth = isSameMonth(day, currentDate);
              const isTodayDate = isToday(day);
              const totalItems = dayEvents.length + dayTasks.length;
              const hiddenCount = Math.max(0, totalItems - MAX_VISIBLE_EVENTS);

              return (
                <div
                  key={day.toISOString()}
                  className={cn(
                    'min-h-24 border-r last:border-r-0 p-1 cursor-pointer transition-colors hover:bg-muted/30',
                    !isCurrentMonth && 'bg-muted/10',
                    isTodayDate && 'bg-primary/5'
                  )}
                  onClick={() => handleCellClick(day)}
                >
                  {/* Day number */}
                  <button
                    className={cn(
                      'w-7 h-7 flex items-center justify-center rounded-full text-sm font-medium mb-1 transition-colors',
                      isTodayDate
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted',
                      !isCurrentMonth && 'text-muted-foreground'
                    )}
                    onClick={(e) => handleDayClick(day, e)}
                  >
                    {format(day, 'd')}
                  </button>

                  {/* Events and tasks */}
                  <div className="space-y-0.5 overflow-hidden">
                    {/* Events first (take precedence) */}
                    {dayEvents.slice(0, MAX_VISIBLE_EVENTS).map((event) => (
                      <EventPill
                        key={event.id}
                        event={event}
                        onClick={(e) => {
                          e.stopPropagation();
                          handlers.onEventClick(event);
                        }}
                      />
                    ))}

                    {/* Tasks (only if room) */}
                    {dayTasks
                      .slice(0, Math.max(0, MAX_VISIBLE_EVENTS - dayEvents.length))
                      .map((task) => (
                        <TaskPill
                          key={task.id}
                          task={task}
                          onClick={(e) => {
                            e.stopPropagation();
                            handlers.onTaskClick?.(task);
                          }}
                        />
                      ))}

                    {/* Overflow indicator */}
                    {hiddenCount > 0 && (
                      <button
                        className="text-xs text-muted-foreground hover:text-foreground px-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlers.onDateChange(day);
                          handlers.onViewChange('day');
                        }}
                      >
                        +{hiddenCount} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// Event pill component
function EventPill({
  event,
  onClick,
}: {
  event: CalendarEvent;
  onClick: (e: React.MouseEvent) => void;
}) {
  const colors = getEventColors(event.color);
  const isAllDay = event.allDay;
  const startTime = isAllDay ? '' : format(new Date(event.startAt), 'h:mm a');

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
      {!isAllDay && <span className="font-medium mr-1">{startTime}</span>}
      {event.title}
    </button>
  );
}

// Task pill component (muted styling)
function TaskPill({
  task,
  onClick,
}: {
  task: TaskWithDueDate;
  onClick: (e: React.MouseEvent) => void;
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
