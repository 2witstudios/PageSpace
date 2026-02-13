'use client';

import { useMemo } from 'react';
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  isToday as checkIsToday,
  isTomorrow,
  isYesterday,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { MapPin, Clock, Users, ExternalLink, Calendar } from 'lucide-react';
import Link from 'next/link';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  CalendarEvent,
  CalendarHandlers,
  TaskWithDueDate,
  getEventsForDay,
  getTasksForDay,
  getEventColors,
  TASK_OVERLAY_STYLE,
  ATTENDEE_STATUS_CONFIG,
} from './calendar-types';

interface AgendaViewProps {
  currentDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
  showGoogleCalendarHint?: boolean;
}

export function AgendaView({ currentDate, events, tasks, handlers, showGoogleCalendarHint = true }: AgendaViewProps) {
  // Get all days in the current month
  const monthDays = useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    return eachDayOfInterval({ start: monthStart, end: monthEnd });
  }, [currentDate]);

  // Group events and tasks by day
  const dayGroups = useMemo(() => {
    return monthDays
      .map((day) => ({
        date: day,
        events: getEventsForDay(events, day).sort((a, b) => {
          if (a.allDay && !b.allDay) return -1;
          if (!a.allDay && b.allDay) return 1;
          return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
        }),
        tasks: getTasksForDay(tasks, day),
      }))
      .filter((group) => group.events.length > 0 || group.tasks.length > 0);
  }, [monthDays, events, tasks]);

  // Format relative date
  const formatRelativeDate = (date: Date) => {
    if (checkIsToday(date)) return 'Today';
    if (isTomorrow(date)) return 'Tomorrow';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'EEEE, MMMM d');
  };

  if (dayGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <div className="text-lg font-medium">No events this month</div>
        <div className="text-sm mt-1">
          Click &quot;New Event&quot; to add one
        </div>
        {showGoogleCalendarHint && (
          <Link
            href="/settings/integrations/google-calendar"
            className="flex items-center gap-1.5 text-sm mt-4 text-muted-foreground/70 hover:text-primary transition-colors"
          >
            <Calendar className="h-4 w-4" />
            Import from Google Calendar
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto p-4 space-y-6">
        {dayGroups.map((group) => {
          const isTodayDate = checkIsToday(group.date);

          return (
            <div key={group.date.toISOString()}>
              {/* Day header */}
              <div
                className={cn(
                  'sticky top-0 z-10 bg-background/95 backdrop-blur-sm py-2 mb-2 border-b',
                  isTodayDate && 'border-primary'
                )}
              >
                <button
                  className="flex items-center gap-3 hover:text-primary transition-colors"
                  onClick={() => {
                    handlers.onDateChange(group.date);
                    handlers.onViewChange('day');
                  }}
                >
                  <div
                    className={cn(
                      'w-10 h-10 flex items-center justify-center rounded-full font-bold',
                      isTodayDate
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted'
                    )}
                  >
                    {format(group.date, 'd')}
                  </div>
                  <div>
                    <div className="font-semibold">{formatRelativeDate(group.date)}</div>
                    {!isTodayDate && (
                      <div className="text-xs text-muted-foreground">
                        {format(group.date, 'yyyy')}
                      </div>
                    )}
                  </div>
                </button>
              </div>

              {/* Events for this day */}
              <div className="space-y-2 pl-14">
                {/* Events first (take visual precedence) */}
                {group.events.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    onClick={() => handlers.onEventClick(event)}
                  />
                ))}

                {/* Tasks */}
                {group.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onClick={() => handlers.onTaskClick?.(task)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Event card component
function EventCard({
  event,
  onClick,
}: {
  event: CalendarEvent;
  onClick: () => void;
}) {
  const colors = getEventColors(event.color);
  const isAllDay = event.allDay;
  const startTime = format(new Date(event.startAt), 'h:mm a');
  const endTime = format(new Date(event.endAt), 'h:mm a');

  return (
    <button
      className={cn(
        'w-full text-left p-4 rounded-lg border-l-4 shadow-sm hover:shadow-md transition-shadow',
        colors.bg,
        colors.border
      )}
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold truncate">{event.title}</h3>
          {event.description && (
            <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
              {event.description}
            </p>
          )}
        </div>
        {event.page && (
          <Badge variant="outline" className="shrink-0">
            <ExternalLink className="w-3 h-3 mr-1" />
            {event.page.title}
          </Badge>
        )}
      </div>

      {/* Metadata */}
      <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-muted-foreground">
        {/* Time */}
        <div className="flex items-center gap-1">
          <Clock className="w-4 h-4" />
          {isAllDay ? (
            <span>All day</span>
          ) : (
            <span>
              {startTime} - {endTime}
            </span>
          )}
        </div>

        {/* Location */}
        {event.location && (
          <div className="flex items-center gap-1">
            <MapPin className="w-4 h-4" />
            <span className="truncate max-w-48">{event.location}</span>
          </div>
        )}

        {/* Drive */}
        {event.drive && (
          <Badge variant="secondary" className="text-xs">
            {event.drive.name}
          </Badge>
        )}
      </div>

      {/* Attendees */}
      {event.attendees.length > 0 && (
        <div className="flex items-center gap-2 mt-3">
          <Users className="w-4 h-4 text-muted-foreground" />
          <div className="flex -space-x-2">
            {event.attendees.slice(0, 5).map((attendee) => (
              <Avatar
                key={attendee.id}
                className="w-6 h-6 border-2 border-background"
                title={`${attendee.user.name} - ${ATTENDEE_STATUS_CONFIG[attendee.status].label}`}
              >
                <AvatarImage src={attendee.user.image ?? undefined} />
                <AvatarFallback className="text-[10px]">
                  {attendee.user.name?.charAt(0) ?? '?'}
                </AvatarFallback>
              </Avatar>
            ))}
          </div>
          {event.attendees.length > 5 && (
            <span className="text-xs text-muted-foreground">
              +{event.attendees.length - 5} more
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// Task card component (muted styling)
function TaskCard({
  task,
  onClick,
}: {
  task: TaskWithDueDate;
  onClick: () => void;
}) {
  const isCompleted = task.status === 'completed';
  const priorityColors = {
    low: 'text-muted-foreground',
    medium: 'text-amber-600',
    high: 'text-red-600',
  };

  return (
    <button
      className={cn(
        'w-full text-left p-4 rounded-lg border-l-4 shadow-sm',
        TASK_OVERLAY_STYLE.bg,
        TASK_OVERLAY_STYLE.border,
        TASK_OVERLAY_STYLE.opacity,
        'hover:opacity-100 transition-opacity'
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        <span className={cn('text-lg', isCompleted && 'text-green-600')}>
          {isCompleted ? '✓' : '☐'}
        </span>
        <div className="flex-1 min-w-0">
          <h3
            className={cn(
              'font-medium truncate',
              isCompleted && 'line-through text-muted-foreground'
            )}
          >
            {task.title}
          </h3>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="text-xs">
              {task.status.replace('_', ' ')}
            </Badge>
            <span className={cn('text-xs', priorityColors[task.priority])}>
              {task.priority} priority
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
