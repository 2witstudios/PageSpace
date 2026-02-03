'use client';

import { useState, useCallback } from 'react';
import { format, addMonths, subMonths, addWeeks, subWeeks, addDays, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, Calendar as CalendarIcon, List, LayoutGrid, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useMobile } from '@/hooks/useMobile';
import { useCalendarData } from './useCalendarData';
import { MonthView } from './MonthView';
import { WeekView } from './WeekView';
import { DayView } from './DayView';
import { AgendaView } from './AgendaView';
import { MobileCalendarView } from './MobileCalendarView';
import { EventModal } from './EventModal';
import {
  CalendarViewMode,
  CalendarEvent,
  CalendarHandlers,
} from './calendar-types';

interface CalendarViewProps {
  context: 'user' | 'drive';
  driveId?: string;
  driveName?: string;
  className?: string;
}

export function CalendarView({ context, driveId, driveName: _driveName, className }: CalendarViewProps) {
  const isMobile = useMobile();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const [showTasks, setShowTasks] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [newEventDefaults, setNewEventDefaults] = useState<{
    startAt: Date;
    endAt: Date;
    allDay: boolean;
  } | null>(null);

  const {
    events,
    tasks,
    isLoading,
    error,
    createEvent,
    updateEvent,
    deleteEvent,
    refresh: _refresh,
  } = useCalendarData({
    context,
    driveId,
    currentDate,
    includePersonal: context === 'user',
    includeTasks: showTasks,
  });

  // Navigation handlers
  const handlePrevious = useCallback(() => {
    switch (viewMode) {
      case 'month':
        setCurrentDate((d) => subMonths(d, 1));
        break;
      case 'week':
        setCurrentDate((d) => subWeeks(d, 1));
        break;
      case 'day':
        setCurrentDate((d) => subDays(d, 1));
        break;
      case 'agenda':
        setCurrentDate((d) => subMonths(d, 1));
        break;
    }
  }, [viewMode]);

  const handleNext = useCallback(() => {
    switch (viewMode) {
      case 'month':
        setCurrentDate((d) => addMonths(d, 1));
        break;
      case 'week':
        setCurrentDate((d) => addWeeks(d, 1));
        break;
      case 'day':
        setCurrentDate((d) => addDays(d, 1));
        break;
      case 'agenda':
        setCurrentDate((d) => addMonths(d, 1));
        break;
    }
  }, [viewMode]);

  const handleToday = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  // Calendar handlers
  const handlers: CalendarHandlers = {
    onEventClick: (event) => {
      setSelectedEvent(event);
      setNewEventDefaults(null);
      setIsEventModalOpen(true);
    },
    onEventCreate: (start, end, allDay = false) => {
      setSelectedEvent(null);
      setNewEventDefaults({ startAt: start, endAt: end, allDay });
      setIsEventModalOpen(true);
    },
    onEventUpdate: async (eventId, updates) => {
      await updateEvent(eventId, updates);
    },
    onEventDelete: async (eventId) => {
      await deleteEvent(eventId);
      setIsEventModalOpen(false);
    },
    onTaskClick: (task) => {
      // Navigate to task list page
      window.location.href = `/dashboard/${task.driveId}/${task.taskListPageId}`;
    },
    onDateChange: setCurrentDate,
    onViewChange: setViewMode,
  };

  // Handle event modal save
  const handleEventSave = async (eventData: {
    title: string;
    description?: string;
    location?: string;
    startAt: Date;
    endAt: Date;
    allDay: boolean;
    color?: string;
    attendeeIds?: string[];
  }) => {
    if (selectedEvent) {
      await updateEvent(selectedEvent.id, eventData);
    } else {
      await createEvent(eventData);
    }
    setIsEventModalOpen(false);
  };

  // Get header title based on view mode
  const getHeaderTitle = () => {
    switch (viewMode) {
      case 'month':
        return format(currentDate, 'MMMM yyyy');
      case 'week':
        return format(currentDate, "'Week of' MMM d, yyyy");
      case 'day':
        return format(currentDate, 'EEEE, MMMM d, yyyy');
      case 'agenda':
        return format(currentDate, 'MMMM yyyy');
    }
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive">
        Failed to load calendar
      </div>
    );
  }

  // Render mobile-optimized view on small screens
  if (isMobile) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <MobileCalendarView
          events={events}
          tasks={tasks}
          handlers={handlers}
          showTasks={showTasks}
          onShowTasksChange={setShowTasks}
          isLoading={isLoading}
        />
        {/* Event modal - shared between mobile and desktop */}
        <EventModal
          isOpen={isEventModalOpen}
          onClose={() => setIsEventModalOpen(false)}
          event={selectedEvent}
          defaultValues={newEventDefaults}
          onSave={handleEventSave}
          onDelete={selectedEvent ? async () => { await handlers.onEventDelete(selectedEvent.id); } : undefined}
          driveId={driveId}
          context={context}
        />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-b bg-background">
        <div className="flex items-center gap-3">
          {/* Navigation */}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" onClick={handlePrevious} aria-label="Previous">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={handleToday}>
              Today
            </Button>
            <Button variant="outline" size="icon" onClick={handleNext} aria-label="Next">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Title */}
          <h2 className="text-lg font-semibold">{getHeaderTitle()}</h2>
        </div>

        <div className="flex items-center gap-2">
          {/* View mode selector */}
          <div className="hidden sm:flex items-center bg-muted rounded-md p-0.5">
            <button
              onClick={() => setViewMode('month')}
              className={cn(
                'p-1.5 rounded transition-colors',
                viewMode === 'month'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              title="Month view"
              aria-label="Month view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('week')}
              className={cn(
                'p-1.5 rounded transition-colors',
                viewMode === 'week'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              title="Week view"
              aria-label="Week view"
            >
              <CalendarIcon className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('day')}
              className={cn(
                'p-1.5 rounded transition-colors',
                viewMode === 'day'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              title="Day view"
              aria-label="Day view"
            >
              <Clock className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('agenda')}
              className={cn(
                'p-1.5 rounded transition-colors',
                viewMode === 'agenda'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              title="Agenda view"
              aria-label="Agenda view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>

          {/* Mobile view selector */}
          <Select
            value={viewMode}
            onValueChange={(value: CalendarViewMode) => setViewMode(value)}
          >
            <SelectTrigger className="w-28 sm:hidden">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">Month</SelectItem>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="day">Day</SelectItem>
              <SelectItem value="agenda">Agenda</SelectItem>
            </SelectContent>
          </Select>

          {/* Tasks toggle */}
          <Toggle
            pressed={showTasks}
            onPressedChange={setShowTasks}
            size="sm"
            aria-label="Show tasks"
            className="data-[state=on]:bg-primary/10"
          >
            Tasks
          </Toggle>

          {/* New event button */}
          <Button
            size="sm"
            onClick={() => {
              // Use currentDate to respect user's navigation
              const baseDate = new Date(currentDate);
              const now = new Date();
              // If viewing today, use current time; otherwise use a reasonable default (9 AM)
              const isToday = baseDate.toDateString() === now.toDateString();
              const start = new Date(baseDate);
              if (isToday) {
                start.setMinutes(0, 0, 0);
                start.setHours(now.getHours() + 1);
              } else {
                start.setHours(9, 0, 0, 0);
              }
              const end = new Date(start);
              end.setHours(end.getHours() + 1);
              handlers.onEventCreate(start, end);
            }}
          >
            <Plus className="h-4 w-4 mr-1" />
            <span className="hidden sm:inline">New Event</span>
          </Button>
        </div>
      </div>

      {/* Calendar content */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : (
          <>
            {viewMode === 'month' && (
              <MonthView
                currentDate={currentDate}
                events={events}
                tasks={showTasks ? tasks : []}
                handlers={handlers}
              />
            )}
            {viewMode === 'week' && (
              <WeekView
                currentDate={currentDate}
                events={events}
                tasks={showTasks ? tasks : []}
                handlers={handlers}
              />
            )}
            {viewMode === 'day' && (
              <DayView
                currentDate={currentDate}
                events={events}
                tasks={showTasks ? tasks : []}
                handlers={handlers}
              />
            )}
            {viewMode === 'agenda' && (
              <AgendaView
                currentDate={currentDate}
                events={events}
                tasks={showTasks ? tasks : []}
                handlers={handlers}
              />
            )}
          </>
        )}
      </div>

      {/* Event modal */}
      <EventModal
        isOpen={isEventModalOpen}
        onClose={() => setIsEventModalOpen(false)}
        event={selectedEvent}
        defaultValues={newEventDefaults}
        onSave={handleEventSave}
        onDelete={selectedEvent ? async () => { await handlers.onEventDelete(selectedEvent.id); } : undefined}
        driveId={driveId}
        context={context}
      />
    </div>
  );
}
// CI trigger
