'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import { format, addMonths, subMonths, addWeeks, subWeeks, addDays, subDays } from 'date-fns';
import { Bot, ChevronLeft, ChevronRight, Plus, Calendar as CalendarIcon, List, LayoutGrid, Clock, PanelLeft, User } from 'lucide-react';
import useSWR from 'swr';
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
import { useDeviceTier } from '@/hooks/useDeviceTier';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useDriveStore } from '@/hooks/useDrive';
import { useCalendarFilterStore } from '@/stores/useCalendarFilterStore';
import { useCalendarData } from './useCalendarData';
import { MonthView } from './MonthView';
import { WeekView } from './WeekView';
import { DayView } from './DayView';
import { AgendaView } from './AgendaView';
import { MobileCalendarView } from './MobileCalendarView';
import { EventModal } from './EventModal';
import { CalendarSidebar } from './CalendarSidebar';
import {
  CalendarViewMode,
  CalendarEvent,
  CalendarHandlers,
  EventColorConfig,
  getDriveCalendarColor,
} from './calendar-types';

interface CalendarViewProps {
  context: 'user' | 'drive';
  driveId?: string;
  driveName?: string;
  className?: string;
}

interface GoogleCalendarStatusResponse {
  connected: boolean;
  connection: {
    id: string;
  } | null;
}

const googleCalendarStatusFetcher = async (url: string): Promise<GoogleCalendarStatusResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch Google Calendar status');
  }
  return response.json();
};

export function CalendarView({ context, driveId, driveName: _driveName, className }: CalendarViewProps) {
  const { tier } = useDeviceTier();
  const shouldUseMobileCalendar = tier === 'mobile';
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

  // Drive filtering (root calendar only)
  const drives = useDriveStore((s) => s.drives);
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const { hiddenCalendars, toggleCalendar, showAll, hideAll, hiddenEventTypes, toggleEventType, isEventTypeVisible } =
    useCalendarFilterStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Force-refresh drives on mount so the sidebar reflects current memberships
  const isUserContext = context === 'user';
  useEffect(() => {
    if (isUserContext) fetchDrives(false, true);
  }, [isUserContext, fetchDrives]);

  // Build drive color map
  const driveColorMap = useMemo(() => {
    if (!isUserContext) return null;
    const map = new Map<string | null, EventColorConfig>();
    const driveIds = drives.map((d) => d.id);
    map.set(null, getDriveCalendarColor(null, driveIds));
    for (const drive of drives) {
      map.set(drive.id, getDriveCalendarColor(drive.id, driveIds));
    }
    return map;
  }, [isUserContext, drives]);

  // Build sidebar calendar entries
  const calendarEntries = useMemo(() => {
    if (!isUserContext || !driveColorMap) return [];
    const entries = [
      {
        key: 'personal',
        name: 'Personal',
        color: driveColorMap.get(null)!,
        visible: !hiddenCalendars.includes('personal'),
      },
    ];
    for (const drive of drives) {
      entries.push({
        key: drive.id,
        name: drive.name,
        color: driveColorMap.get(drive.id)!,
        visible: !hiddenCalendars.includes(drive.id),
      });
    }
    return entries;
  }, [isUserContext, driveColorMap, drives, hiddenCalendars]);

  // Filter events and tasks by visibility
  const filteredEvents = useMemo(() => {
    let result = isUserContext
      ? events.filter((e) => !hiddenCalendars.includes(e.driveId ?? 'personal'))
      : events;
    if (hiddenEventTypes.length > 0) {
      result = result.filter((e) => {
        const type = e.hasAgentTrigger ? 'agent' : 'user';
        return isEventTypeVisible(type);
      });
    }
    return result;
  }, [isUserContext, events, hiddenCalendars, hiddenEventTypes, isEventTypeVisible]);

  const filteredTasks = useMemo(() => {
    if (!isUserContext) return tasks;
    return tasks.filter((t) => !hiddenCalendars.includes(t.driveId));
  }, [isUserContext, tasks, hiddenCalendars]);

  const allCalendarKeys = useMemo(
    () => calendarEntries.map((c) => c.key),
    [calendarEntries]
  );

  const { data: googleCalendarStatus } = useSWR<GoogleCalendarStatusResponse>(
    '/api/integrations/google-calendar/status',
    googleCalendarStatusFetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 60000,
    }
  );

  const showGoogleCalendarHint = !googleCalendarStatus?.connection;

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
    agentTrigger?: { agentPageId: string; prompt: string };
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
  if (shouldUseMobileCalendar) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <MobileCalendarView
          events={filteredEvents}
          tasks={filteredTasks}
          handlers={handlers}
          showTasks={showTasks}
          onShowTasksChange={setShowTasks}
          showGoogleCalendarHint={showGoogleCalendarHint}
          isLoading={isLoading}
          currentDate={currentDate}
          driveColorMap={driveColorMap}
          context={context}
          calendarEntries={isUserContext ? calendarEntries : undefined}
          onToggleCalendar={toggleCalendar}
          onShowAllCalendars={showAll}
          onHideAllCalendars={() => hideAll(allCalendarKeys)}
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
          {/* Sidebar toggle (root calendar only) */}
          {isUserContext && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-label={sidebarOpen ? 'Hide calendars sidebar' : 'Show calendars sidebar'}
              className="hidden sm:flex"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
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

          {/* Event type filters (drive context — in user context these live in the sidebar) */}
          {!isUserContext && (
            <div className="flex items-center gap-1">
              <Toggle
                pressed={isEventTypeVisible('user')}
                onPressedChange={() => toggleEventType('user')}
                size="sm"
                aria-label="Show user events"
                title="User events"
                className="data-[state=on]:bg-primary/10 gap-1"
              >
                <User className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Events</span>
              </Toggle>
              <Toggle
                pressed={isEventTypeVisible('agent')}
                onPressedChange={() => toggleEventType('agent')}
                size="sm"
                aria-label="Show agent events"
                title="Agent events"
                className="data-[state=on]:bg-primary/10 gap-1"
              >
                <Bot className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Agents</span>
              </Toggle>
            </div>
          )}

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

      {/* Calendar body: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar (root calendar, desktop only) */}
        {isUserContext && sidebarOpen && (
          <aside className="w-52 shrink-0 border-r overflow-y-auto p-3 hidden sm:block">
            <CalendarSidebar
              calendars={calendarEntries}
              onToggle={toggleCalendar}
              onShowAll={showAll}
              onHideAll={() => hideAll(allCalendarKeys)}
              agentEventsVisible={isEventTypeVisible('agent')}
              userEventsVisible={isEventTypeVisible('user')}
              onToggleAgentEvents={() => toggleEventType('agent')}
              onToggleUserEvents={() => toggleEventType('user')}
            />
          </aside>
        )}

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
                  events={filteredEvents}
                  tasks={showTasks ? filteredTasks : []}
                  handlers={handlers}
                  driveColorMap={driveColorMap}
                  context={context}
                />
              )}
              {viewMode === 'week' && (
                <WeekView
                  currentDate={currentDate}
                  events={filteredEvents}
                  tasks={showTasks ? filteredTasks : []}
                  handlers={handlers}
                  driveColorMap={driveColorMap}
                  context={context}
                />
              )}
              {viewMode === 'day' && (
                <DayView
                  currentDate={currentDate}
                  events={filteredEvents}
                  tasks={showTasks ? filteredTasks : []}
                  handlers={handlers}
                  driveColorMap={driveColorMap}
                  context={context}
                />
              )}
              {viewMode === 'agenda' && (
                <AgendaView
                  currentDate={currentDate}
                  events={filteredEvents}
                  tasks={showTasks ? filteredTasks : []}
                  handlers={handlers}
                  showGoogleCalendarHint={showGoogleCalendarHint}
                  driveColorMap={driveColorMap}
                  context={context}
                />
              )}
            </>
          )}
        </div>
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
