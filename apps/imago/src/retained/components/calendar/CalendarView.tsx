'use client';

import { useState, useCallback, useMemo, useEffect, type SetStateAction } from 'react';
import { useRouter, useSearchParams } from '@/retained-adapters/navigation';
import { format, addMonths, subMonths, addWeeks, subWeeks, addDays, subDays } from 'date-fns';
import { Bot, ChevronLeft, ChevronRight, Plus, Calendar as CalendarIcon, List, LayoutGrid, Clock, PanelLeft, User } from 'lucide-react';
import useSWR from 'swr';
import { Button } from '@/retained/components/ui/button';
import { FocusTrigger } from '@/retained/components/shared/FocusTrigger';
import { Toggle } from '@/retained/components/ui/toggle';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/retained/components/ui/select';
import { cn } from '@/retained/lib/utils';
import { useDeviceTier } from '@/retained/hooks/useDeviceTier';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useCalendarFilterStore } from '@/retained/stores/useCalendarFilterStore';
import { useCalendarData } from './useCalendarData';
import { MonthView } from './MonthView';
import { WeekView } from './WeekView';
import { DayView } from './DayView';
import { AgendaView } from './AgendaView';
import { MobileCalendarView } from './MobileCalendarView';
import { EventModal } from './EventModal';
import { CalendarSidebar } from './CalendarSidebar';
import {
  AttendeeStatus,
  CalendarViewMode,
  CalendarEvent,
  CalendarHandlers,
  EventColorConfig,
  RecurrenceRule,
  getDriveCalendarColor,
} from './calendar-types';
import { useAuthStore } from '@/retained/stores/useAuthStore';
import { EventPopover } from '@/ui/tools/calendar/event-popover';
import { defaultNewEventRange } from '@/ui/tools/calendar/calendar-state';
import { WEEK_STARTS_ON } from '@/ui/tools/calendar/calendar-state';

/**
 * The Calendar tool's middle (C-Drive-Calendar). The shell's pane and toolbar own the view, the
 * visible date, the open event and event creation, so this grid takes them as props, and draws no
 * header or sidebar of its own.
 */
export interface EmbeddedCalendarState {
  readonly viewMode: CalendarViewMode;
  readonly currentDate: Date;
  readonly openEventId: string | null;
  readonly composing: boolean;
  readonly onViewModeChange: (view: CalendarViewMode) => void;
  readonly onDateChange: (date: Date) => void;
  readonly onOpenEventChange: (eventId: string | null) => void;
  readonly onComposingChange: (composing: boolean) => void;
  /** Lifted task visibility, for a shell that draws its own Show tasks control. Defaults to shown. */
  readonly showTasks?: boolean;
  readonly onShowTasksChange?: (showTasks: boolean) => void;
}

interface CalendarViewProps {
  context: 'user' | 'drive';
  driveId?: string;
  driveName?: string;
  className?: string;
  embedded?: EmbeddedCalendarState;
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

export function CalendarView({ context, driveId, driveName: _driveName, className, embedded }: CalendarViewProps) {
  const { tier } = useDeviceTier();
  const shouldUseMobileCalendar = tier === 'mobile';

  // Deep-link support: a tool-call card (or any link) can open a specific event
  // via ?eventId=<id>&date=<ISO>. The date seeds the initial view window so the
  // target event is actually loaded before we open its modal.
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkEventId = searchParams.get('eventId');
  const deepLinkDate = searchParams.get('date');

  const [localDate, setLocalDate] = useState(() => {
    if (deepLinkDate) {
      const d = new Date(deepLinkDate);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  });
  const [localViewMode, setLocalViewMode] = useState<CalendarViewMode>('month');
  const currentDate = embedded ? embedded.currentDate : localDate;
  const viewMode = embedded ? embedded.viewMode : localViewMode;
  const embeddedDateChange = embedded?.onDateChange;
  const setCurrentDate = useCallback(
    (next: SetStateAction<Date>) => {
      if (!embeddedDateChange) {
        setLocalDate(next);
        return;
      }
      embeddedDateChange(typeof next === 'function' ? next(currentDate) : next);
    },
    [embeddedDateChange, currentDate],
  );
  const setViewMode = embedded ? embedded.onViewModeChange : setLocalViewMode;
  const [localShowTasks, setLocalShowTasks] = useState(true);
  const showTasks = embedded?.showTasks ?? localShowTasks;
  const setShowTasks = embedded?.onShowTasksChange ?? setLocalShowTasks;
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  // Track which deep-linked event id we've already opened, so a second event
  // link clicked on the same page (no remount) still opens.
  const [handledDeepLinkId, setHandledDeepLinkId] = useState<string | null>(null);
  const [newEventDefaults, setNewEventDefaults] = useState<{
    startAt: Date;
    endAt: Date;
    allDay: boolean;
  } | null>(null);

  const currentUserId = useAuthStore((s) => s.user?.id);

  const {
    events,
    tasks,
    isLoading,
    error,
    createEvent,
    updateEvent,
    deleteEvent,
    updateRsvp,
    addAttendees,
    removeAttendee,
    refresh: _refresh,
  } = useCalendarData({
    context,
    driveId,
    currentDate,
    includePersonal: context === 'user',
    includeTasks: showTasks,
  });

  // Open the deep-linked event once it appears in the loaded set. Keyed on the
  // event id (not a one-shot flag) so clicking a different event link while
  // already on the calendar opens the new event too. If the target isn't in the
  // current window yet, jump the view to its date so the fetch includes it.
  useEffect(() => {
    // Embedded: the shell's URL state carries the open event and the date.
    if (embedded) return;
    if (!deepLinkEventId || deepLinkEventId === handledDeepLinkId) return;
    const match = events.find((e) => e.id === deepLinkEventId);
    if (match) {
      setSelectedEvent(match);
      setIsEventModalOpen(true);
      setHandledDeepLinkId(deepLinkEventId);
      return;
    }
    if (deepLinkDate) {
      const target = new Date(deepLinkDate);
      if (!isNaN(target.getTime()) && target.getTime() !== currentDate.getTime()) {
        setCurrentDate(target);
      }
    }
  }, [deepLinkEventId, deepLinkDate, handledDeepLinkId, events, currentDate, setCurrentDate, embedded]);

  // Drive filtering (root calendar only)
  const drives = useDriveStore((s) => s.drives);
  const fetchDrives = useDriveStore((s) => s.fetchDrives);
  const { hiddenCalendars, toggleCalendar, showAll, hideAll, hiddenEventTypes, toggleEventType, isEventTypeVisible } =
    useCalendarFilterStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedCalendarKey, setSelectedCalendarKey] = useState('personal');

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

  // When user context: derive the effective driveId/context for the event modal.
  // Editing an existing event: use the event's own driveId. A null driveId means
  // the event is personal — convert null→undefined so it isn't confused with "no
  // event selected". Never inherit the selected calendar key when editing.
  // Creating a new event: use the selected calendar key.
  const creationDriveId = isUserContext && selectedCalendarKey !== 'personal'
    ? selectedCalendarKey
    : (isUserContext ? undefined : driveId);
  const effectiveModalDriveId = selectedEvent
    ? (selectedEvent.driveId ?? undefined)
    : creationDriveId;
  const effectiveModalContext: 'user' | 'drive' = effectiveModalDriveId ? 'drive' : 'user';

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
  }, [viewMode, setCurrentDate]);

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
  }, [viewMode, setCurrentDate]);

  const handleToday = useCallback(() => {
    setCurrentDate(new Date());
  }, [setCurrentDate]);

  // Calendar handlers
  const handlers: CalendarHandlers = {
    onEventClick: (event) => {
      if (embedded) {
        embedded.onOpenEventChange(event.id);
        return;
      }
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
      // Navigate to task list page. router.push, not window.location: a hard
      // navigation is handed to the iOS shell's navigation policy, which cancels
      // it (see lib/navigation/app-navigator.ts).
      router.push(`/dashboard/${task.driveId}/${task.taskListPageId}`);
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
    pageId?: string | null;
    recurrenceRule?: RecurrenceRule | null;
    agentTrigger?: {
      agentPageId: string;
      prompt?: string;
      instructionPageId: string | null;
      contextPageIds: string[];
    } | null;
  }) => {
    if (selectedEvent) {
      await updateEvent(selectedEvent.id, eventData);
    } else {
      // POST schema doesn't accept null (only undefined no-op or object upsert)
      const { agentTrigger, ...rest } = eventData;
      const driveOverride = isUserContext && selectedCalendarKey !== 'personal'
        ? selectedCalendarKey
        : undefined;
      await createEvent({
        ...rest,
        agentTrigger: agentTrigger ?? undefined,
      }, driveOverride);
    }
    closeEventModal();
  };

  const handleRsvp = useCallback(async (status: AttendeeStatus) => {
    if (!selectedEvent) return;
    const previousEvent = selectedEvent;
    setSelectedEvent((prev) =>
      prev
        ? {
            ...prev,
            attendees: prev.attendees.map((a) =>
              a.userId === currentUserId
                ? { ...a, status, respondedAt: new Date().toISOString() }
                : a,
            ),
          }
        : null,
    );
    try {
      await updateRsvp(selectedEvent.id, status);
    } catch {
      setSelectedEvent(previousEvent);
      throw new Error('Failed to update RSVP');
    }
  }, [selectedEvent, updateRsvp, currentUserId]);

  const handleAddAttendee = useCallback(
    async (userId: string) => {
      if (!selectedEvent) return;
      const prevEvent = selectedEvent;
      setSelectedEvent((prev) =>
        prev
          ? {
              ...prev,
              attendees: [
                ...prev.attendees,
                {
                  id: userId,
                  eventId: prev.id,
                  userId,
                  status: 'PENDING' as const,
                  responseNote: null,
                  isOrganizer: false,
                  isOptional: false,
                  invitedAt: new Date().toISOString(),
                  respondedAt: null,
                  user: { id: userId, name: null, image: null },
                },
              ],
            }
          : null
      );
      const targetEventId = selectedEvent.id;
      try {
        const updatedAttendees = await addAttendees(targetEventId, [userId]);
        if (updatedAttendees.length > 0) {
          setSelectedEvent((prev) =>
            prev && prev.id === targetEventId ? { ...prev, attendees: updatedAttendees } : prev
          );
        }
      } catch {
        setSelectedEvent((prev) =>
          prev && prev.id === targetEventId ? prevEvent : prev
        );
        throw new Error('Failed to add attendee');
      }
    },
    [selectedEvent, addAttendees]
  );

  const handleRemoveAttendee = useCallback(
    async (userId: string) => {
      if (!selectedEvent) return;
      const prevEvent = selectedEvent;
      setSelectedEvent((prev) =>
        prev ? { ...prev, attendees: prev.attendees.filter((a) => a.userId !== userId) } : null
      );
      try {
        await removeAttendee(selectedEvent.id, userId);
      } catch {
        setSelectedEvent(prevEvent);
        throw new Error('Failed to remove attendee');
      }
    },
    [selectedEvent, removeAttendee]
  );

  const closeEventModal = () => {
    setIsEventModalOpen(false);
    embedded?.onComposingChange(false);
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

  // Embedded: the composer opens while the shell's Event button has it open.
  const composing = embedded?.composing ?? false;
  useEffect(() => {
    if (!composing) return;
    const range = defaultNewEventRange(currentDate, new Date());
    setSelectedEvent(null);
    setNewEventDefaults({ startAt: range.startAt, endAt: range.endAt, allDay: false });
    setIsEventModalOpen(true);
  }, [composing, currentDate]);

  const popoverEvent = embedded?.openEventId ? events.find((e) => e.id === embedded.openEventId) ?? null : null;

  const eventModal = (
    <EventModal
      isOpen={isEventModalOpen}
      onClose={closeEventModal}
      event={selectedEvent}
      defaultValues={newEventDefaults}
      onSave={handleEventSave}
      onDelete={selectedEvent ? async () => { await handlers.onEventDelete(selectedEvent.id); } : undefined}
      onRsvp={handleRsvp}
      onAddAttendee={handleAddAttendee}
      onRemoveAttendee={handleRemoveAttendee}
      driveId={effectiveModalDriveId}
      context={effectiveModalContext}
    />
  );

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
          focusTrigger={
            // 32px, like the tasks toggle and the filter it sits between.
            <FocusTrigger section="calendar" variant="compact" size="sm" />
          }
          calendarEntries={isUserContext ? calendarEntries : undefined}
          onToggleCalendar={toggleCalendar}
          onShowAllCalendars={showAll}
          onHideAllCalendars={() => hideAll(allCalendarKeys)}
        />
        {eventModal}
      </div>
    );
  }

  return (
    <div className={cn('relative flex flex-col h-full', className)}>
      {/* Header (the shell's toolbar stands in for it when embedded) */}
      {embedded ? null : <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-b bg-background">
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

          {/* The focus, as a subtitle-sized chip after the month. Context IS the focus here. */}
          <FocusTrigger section="calendar" />
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
      </div>}

      {/* Calendar body: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar (root calendar, desktop only) */}
        {isUserContext && !embedded && sidebarOpen && (
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
              selectedKey={selectedCalendarKey}
              onSelectCalendar={setSelectedCalendarKey}
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
                  weekStartsOn={embedded ? WEEK_STARTS_ON : 0}
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

      {popoverEvent ? (
        <EventPopover
          event={popoverEvent}
          onClose={() => embedded?.onOpenEventChange(null)}
          onEdit={() => {
            embedded?.onOpenEventChange(null);
            setSelectedEvent(popoverEvent);
            setNewEventDefaults(null);
            setIsEventModalOpen(true);
          }}
          onGoing={() => updateRsvp(popoverEvent.id, 'ACCEPTED').then(() => undefined)}
        />
      ) : null}

      {eventModal}
    </div>
  );
}
