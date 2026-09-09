'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  format,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { ChevronDown, ListTodo, Plus, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileWeekStrip } from './MobileWeekStrip';
import { MobileAgenda, type MobileAgendaHandle } from './MobileAgenda';
import { MobileMonthPicker } from './MobileMonthPicker';
import { CalendarSidebar } from './CalendarSidebar';
import { useCalendarFilterStore } from '@/stores/useCalendarFilterStore';
import {
  CalendarEvent,
  CalendarHandlers,
  TaskWithDueDate,
  EventColorConfig,
  isSameDay,
  isToday,
  resolveSwipeDirection,
} from './calendar-types';

interface CalendarEntryForMobile {
  key: string;
  name: string;
  color: EventColorConfig;
  visible: boolean;
}

interface MobileCalendarViewProps {
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
  showTasks: boolean;
  onShowTasksChange: (show: boolean) => void;
  showGoogleCalendarHint?: boolean;
  isLoading?: boolean;
  currentDate?: Date;
  driveColorMap?: Map<string | null, EventColorConfig> | null;
  context?: 'user' | 'drive';
  calendarEntries?: CalendarEntryForMobile[];
  onToggleCalendar?: (key: string) => void;
  onShowAllCalendars?: () => void;
  onHideAllCalendars?: () => void;
}

export function MobileCalendarView({
  events,
  tasks,
  handlers,
  showTasks,
  onShowTasksChange,
  showGoogleCalendarHint = true,
  isLoading,
  currentDate: parentDate,
  driveColorMap,
  context = 'drive',
  calendarEntries,
  onToggleCalendar,
  onShowAllCalendars,
  onHideAllCalendars,
}: MobileCalendarViewProps) {
  const { isEventTypeVisible, toggleEventType } = useCalendarFilterStore();
  const [selectedDate, setSelectedDate] = useState(() => parentDate ?? new Date());
  const [isMonthPickerOpen, setIsMonthPickerOpen] = useState(false);
  const [isStripExpanded, setIsStripExpanded] = useState(false);
  // Set when the user picks a date; cleared once the agenda has scrolled to it.
  const [pendingScroll, setPendingScroll] = useState<Date | null>(null);
  const [pinnedDate, setPinnedDate] = useState<Date | null>(null);

  const agendaRef = useRef<MobileAgendaHandle>(null);

  // Sync with parent date when it changes externally
  useEffect(() => {
    if (!parentDate) return;
    setSelectedDate((previousDate) =>
      isSameDay(parentDate, previousDate) ? previousDate : parentDate
    );
  }, [parentDate]);

  useEffect(() => {
    if (!pendingScroll) return;
    agendaRef.current?.scrollToDate(pendingScroll);
    setPendingScroll(null);
  }, [pendingScroll]);

  // The window useCalendarData has actually fetched. Keyed on the month, not the
  // date, so scroll-sync within a month does not hand the agenda a new array.
  const monthKey = format(selectedDate, 'yyyy-MM');
  const agendaDays = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(selectedDate)),
        end: endOfWeek(endOfMonth(selectedDate)),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- monthKey is the identity of selectedDate that matters here
    [monthKey]
  );

  const goToDate = useCallback(
    (date: Date, { scroll }: { scroll: boolean }) => {
      setSelectedDate(date);
      handlers.onDateChange(date);
      if (scroll) {
        setPinnedDate(date);
        setPendingScroll(date);
      }
    },
    [handlers]
  );

  const handleDateSelect = useCallback(
    (date: Date) => {
      goToDate(date, { scroll: true });
      setIsStripExpanded(false);
    },
    [goToDate]
  );

  // Scrolling the agenda past a day boundary moves the strip, but must not
  // scroll the agenda back -- that would fight the user's own gesture.
  const handleVisibleDateChange = useCallback(
    (date: Date) => goToDate(date, { scroll: false }),
    [goToDate]
  );

  const handleMonthSelect = useCallback(
    (date: Date) => {
      goToDate(date, { scroll: true });
      setIsMonthPickerOpen(false);
    },
    [goToDate]
  );

  const handleTodayClick = useCallback(() => {
    goToDate(new Date(), { scroll: true });
  }, [goToDate]);

  const handleCreateEvent = useCallback(() => {
    const start = new Date(selectedDate);
    const now = new Date();

    if (isToday(selectedDate)) {
      start.setMinutes(0, 0, 0);
      start.setHours(now.getHours() + 1);
    } else {
      start.setHours(9, 0, 0, 0);
    }

    const end = new Date(start);
    end.setHours(end.getHours() + 1);
    handlers.onEventCreate(start, end);
  }, [selectedDate, handlers]);

  // Horizontal belongs to the strip, not the list: swiping it pages the week
  // (or the month, while it is expanded). The agenda owns the vertical axis.
  const touchRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
    };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchRef.current) return;
    const touch = e.touches[0];
    touchRef.current.lastX = touch.clientX;
    touchRef.current.lastY = touch.clientY;
  }, []);

  const handleTouchEnd = useCallback(() => {
    const gesture = touchRef.current;
    touchRef.current = null;
    if (!gesture) return;

    const direction = resolveSwipeDirection({
      dx: gesture.startX - gesture.lastX,
      dy: gesture.startY - gesture.lastY,
    });
    if (!direction) return;

    const step = direction === 'next' ? 1 : -1;
    const nextDate = isStripExpanded
      ? (step > 0 ? addMonths : subMonths)(selectedDate, 1)
      : (step > 0 ? addWeeks : subWeeks)(selectedDate, 1);
    goToDate(nextDate, { scroll: true });
  }, [isStripExpanded, selectedDate, goToDate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* One date header. The strip and the agenda both restate it below only
          while scrolling, never as fixed chrome. */}
      <div className="flex flex-none items-center justify-between gap-1 border-b bg-background px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-1 px-2 text-base font-semibold">
              {format(selectedDate, 'MMMM yyyy')}
              <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={handleTodayClick}>Go to Today</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setIsMonthPickerOpen(true)}>
              Choose Month...
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-0.5">
          {!isToday(selectedDate) && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-full px-3 text-xs"
              onClick={handleTodayClick}
            >
              Today
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8', showTasks && 'text-primary')}
            aria-pressed={showTasks}
            aria-label={showTasks ? 'Hide tasks' : 'Show tasks'}
            onClick={() => onShowTasksChange(!showTasks)}
          >
            <ListTodo className="h-4 w-4" />
          </Button>

          {calendarEntries && onToggleCalendar && onShowAllCalendars && onHideAllCalendars && (
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Filter calendars"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="h-auto max-h-[60vh]">
                <SheetHeader>
                  <SheetTitle>Calendars</SheetTitle>
                </SheetHeader>
                <div className="py-4">
                  <CalendarSidebar
                    calendars={calendarEntries}
                    onToggle={onToggleCalendar}
                    onShowAll={onShowAllCalendars}
                    onHideAll={onHideAllCalendars}
                    agentEventsVisible={isEventTypeVisible('agent')}
                    userEventsVisible={isEventTypeVisible('user')}
                    onToggleAgentEvents={() => toggleEventType('agent')}
                    onToggleUserEvents={() => toggleEventType('user')}
                  />
                </div>
              </SheetContent>
            </Sheet>
          )}

          <Button
            size="icon"
            className="h-8 w-8"
            aria-label="New event"
            onClick={handleCreateEvent}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        className="flex-none touch-pan-y"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <MobileWeekStrip
          selectedDate={selectedDate}
          events={events}
          tasks={showTasks ? tasks : []}
          onDateSelect={handleDateSelect}
          expanded={isStripExpanded}
          onToggleExpanded={() => setIsStripExpanded((open) => !open)}
          driveColorMap={driveColorMap}
          context={context}
        />
      </div>

      <MobileAgenda
        ref={agendaRef}
        days={agendaDays}
        selectedDate={selectedDate}
        pinnedDate={pinnedDate}
        events={events}
        tasks={tasks}
        handlers={handlers}
        showTasks={showTasks}
        onCreateEvent={handleCreateEvent}
        onVisibleDateChange={handleVisibleDateChange}
        showGoogleCalendarHint={showGoogleCalendarHint}
        driveColorMap={driveColorMap}
        context={context}
      />

      <MobileMonthPicker
        isOpen={isMonthPickerOpen}
        onClose={() => setIsMonthPickerOpen(false)}
        selectedDate={selectedDate}
        onSelect={handleMonthSelect}
      />
    </div>
  );
}
