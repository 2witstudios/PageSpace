'use client';

import { useMemo } from 'react';
import { format, isToday as checkIsToday, isTomorrow, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
import { MapPin, Clock, Users, Plus, Calendar } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

interface MobileDayAgendaProps {
  selectedDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
  showTasks: boolean;
}

export function MobileDayAgenda({
  selectedDate,
  events,
  tasks,
  handlers,
  showTasks,
}: MobileDayAgendaProps) {
  // Get events and tasks for the selected day
  const dayEvents = useMemo(() => getEventsForDay(events, selectedDate), [events, selectedDate]);
  const dayTasks = useMemo(
    () => (showTasks ? getTasksForDay(tasks, selectedDate) : []),
    [tasks, selectedDate, showTasks]
  );

  // Sort events by time (all-day first, then by start time)
  const sortedEvents = useMemo(() => {
    return [...dayEvents].sort((a, b) => {
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
    });
  }, [dayEvents]);

  // Format the date header
  const dateHeader = useMemo(() => {
    if (checkIsToday(selectedDate)) return 'Today';
    if (isTomorrow(selectedDate)) return 'Tomorrow';
    if (isYesterday(selectedDate)) return 'Yesterday';
    return format(selectedDate, 'EEEE');
  }, [selectedDate]);

  const fullDate = format(selectedDate, 'MMMM d, yyyy');
  const hasItems = sortedEvents.length > 0 || dayTasks.length > 0;

  // Handle creating a new event for this day
  const handleCreateEvent = () => {
    const start = new Date(selectedDate);
    const now = new Date();
    const isToday = selectedDate.toDateString() === now.toDateString();

    if (isToday) {
      start.setMinutes(0, 0, 0);
      start.setHours(now.getHours() + 1);
    } else {
      start.setHours(9, 0, 0, 0);
    }

    const end = new Date(start);
    end.setHours(end.getHours() + 1);
    handlers.onEventCreate(start, end);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Day header */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-b">
        <div>
          <h2 className="text-lg font-semibold">{dateHeader}</h2>
          <p className="text-sm text-muted-foreground">{fullDate}</p>
        </div>
        <Button size="sm" onClick={handleCreateEvent}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {/* Events/tasks list */}
      <div className="flex-1 overflow-auto">
        {!hasItems ? (
          <EmptyState onCreateEvent={handleCreateEvent} />
        ) : (
          <div className="p-4 space-y-3">
            {/* All-day events section */}
            {sortedEvents.filter((e) => e.allDay).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  All Day
                </p>
                {sortedEvents
                  .filter((e) => e.allDay)
                  .map((event) => (
                    <MobileEventCard
                      key={event.id}
                      event={event}
                      onClick={() => handlers.onEventClick(event)}
                    />
                  ))}
              </div>
            )}

            {/* Timed events */}
            {sortedEvents.filter((e) => !e.allDay).length > 0 && (
              <div className="space-y-2">
                {sortedEvents.filter((e) => e.allDay).length > 0 && (
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider pt-2">
                    Schedule
                  </p>
                )}
                {sortedEvents
                  .filter((e) => !e.allDay)
                  .map((event) => (
                    <MobileEventCard
                      key={event.id}
                      event={event}
                      onClick={() => handlers.onEventClick(event)}
                    />
                  ))}
              </div>
            )}

            {/* Tasks section */}
            {dayTasks.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider pt-2">
                  Tasks Due
                </p>
                {dayTasks.map((task) => (
                  <MobileTaskCard
                    key={task.id}
                    task={task}
                    onClick={() => handlers.onTaskClick?.(task)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Empty state component
function EmptyState({ onCreateEvent }: { onCreateEvent: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
        <Calendar className="w-8 h-8 text-muted-foreground" />
      </div>
      <h3 className="font-medium text-lg mb-1">No events</h3>
      <p className="text-sm text-muted-foreground mb-4">
        Nothing scheduled for this day
      </p>
      <Button variant="outline" size="sm" onClick={onCreateEvent}>
        <Plus className="h-4 w-4 mr-1" />
        Create Event
      </Button>
    </div>
  );
}

// Mobile-optimized event card
function MobileEventCard({
  event,
  onClick,
}: {
  event: CalendarEvent;
  onClick: () => void;
}) {
  const colors = getEventColors(event.color);
  const startTime = format(new Date(event.startAt), 'h:mm a');
  const endTime = format(new Date(event.endAt), 'h:mm a');

  return (
    <button
      className={cn(
        'w-full text-left p-4 rounded-xl border-l-4 bg-card shadow-sm',
        'active:scale-[0.98] transition-transform',
        colors.border
      )}
      onClick={onClick}
    >
      {/* Title and time */}
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-base flex-1 min-w-0 truncate">
          {event.title}
        </h3>
        {!event.allDay && (
          <div className="flex items-center gap-1 text-sm text-muted-foreground shrink-0">
            <Clock className="w-3.5 h-3.5" />
            <span>{startTime}</span>
          </div>
        )}
      </div>

      {/* Description preview */}
      {event.description && (
        <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
          {event.description}
        </p>
      )}

      {/* Metadata row */}
      <div className="flex flex-wrap items-center gap-3 mt-3">
        {/* Time range for timed events */}
        {!event.allDay && (
          <Badge variant="secondary" className="text-xs">
            {startTime} - {endTime}
          </Badge>
        )}

        {/* Location */}
        {event.location && (
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <MapPin className="w-3.5 h-3.5" />
            <span className="truncate max-w-32">{event.location}</span>
          </div>
        )}

        {/* Drive badge */}
        {event.drive && (
          <Badge variant="outline" className="text-xs">
            {event.drive.name}
          </Badge>
        )}
      </div>

      {/* Attendees */}
      {event.attendees.length > 0 && (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t">
          <Users className="w-4 h-4 text-muted-foreground" />
          <div className="flex -space-x-2">
            {event.attendees.slice(0, 4).map((attendee) => (
              <Avatar
                key={attendee.id}
                className="w-7 h-7 border-2 border-background"
              >
                <AvatarImage src={attendee.user.image ?? undefined} />
                <AvatarFallback className="text-[10px]">
                  {attendee.user.name?.charAt(0) ?? '?'}
                </AvatarFallback>
              </Avatar>
            ))}
          </div>
          {event.attendees.length > 4 && (
            <span className="text-xs text-muted-foreground">
              +{event.attendees.length - 4}
            </span>
          )}
          {/* Show RSVP summary */}
          {event.attendees.some((a) => a.status === 'ACCEPTED') && (
            <Badge variant="secondary" className="text-xs ml-auto">
              {event.attendees.filter((a) => a.status === 'ACCEPTED').length}{' '}
              {ATTENDEE_STATUS_CONFIG.ACCEPTED.label.toLowerCase()}
            </Badge>
          )}
        </div>
      )}
    </button>
  );
}

// Mobile-optimized task card
function MobileTaskCard({
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
        'w-full text-left p-4 rounded-xl border-l-4 bg-card shadow-sm',
        'active:scale-[0.98] transition-transform',
        TASK_OVERLAY_STYLE.border,
        isCompleted && 'opacity-60'
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-3">
        {/* Checkbox indicator */}
        <div
          className={cn(
            'w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0',
            isCompleted
              ? 'bg-green-500 border-green-500 text-white'
              : 'border-muted-foreground'
          )}
        >
          {isCompleted && <span className="text-sm">✓</span>}
        </div>

        {/* Task content */}
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
            <span className={cn('text-xs capitalize', priorityColors[task.priority])}>
              {task.priority}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
