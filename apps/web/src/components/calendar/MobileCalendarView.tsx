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
  // Both start at the initial date: the agenda otherwise opens at the month's
  // first event, and an empty initial date would not be in the list at all.
  const [pendingScroll, setPendingScroll] = useState<Date | null>(
    () => parentDate ?? new Date()
  );
  const [pinnedDate, setPinnedDate] = useState<Date | null>(() => parentDate ?? new Date());
  // The month the agenda window covers. Deliberately separate from
  // `selectedDate`, which scroll-sync moves: deriving the window from it meant
  // scrolling into the trailing days of a month rebuilt the entire list under
  // the user's finger. Only explicit navigation moves the window.
  const [windowDate, setWindowDate] = useState<Date>(() => parentDate ?? new Date());
  const hasScrolledOnce = useRef(false);

  const agendaRef = useRef<MobileAgendaHandle>(null);

  // Sync with parent date when it changes externally -- a deep link, or the
  // date arriving after mount. Pin and scroll to it as if the user had picked
  // it; the guard makes this a no-op for the echo of our own onDateChange.
  useEffect(() => {
    if (!parentDate) return;
    // selectedDate is read as a guard, not a trigger: this effect fires on a new
    // parentDate only, and the guard makes it a no-op for the echo of our own
    // onDateChange. Setters stay out of the updater -- StrictMode calls it twice.
    if (isSameDay(parentDate, selectedDate)) return;
    setSelectedDate(parentDate);
    setWindowDate(parentDate);
    setPinnedDate(parentDate);
    setPendingScroll(parentDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentDate]);

  useEffect(() => {
    if (!pendingScroll) return;
    // Crossing into an uncached month swaps the agenda for a spinner, so the
    // ref is null here. Keep the request and retry when loading finishes --
    // clearing it unconditionally stranded the user on the month's first day.
    const landed = agendaRef.current?.scrollToDate(
      pendingScroll,
      hasScrolledOnce.current ? 'smooth' : 'auto'
    );
    if (!landed) return;
    hasScrolledOnce.current = true;
    setPendingScroll(null);
  }, [pendingScroll, isLoading]);

  // Matches the window useCalendarData fetches for this month. Keyed on the
  // month so a same-month navigation does not hand the agenda a new array.
  const windowKey = format(windowDate, 'yyyy-MM');
  const agendaDays = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(windowDate)),
        end: endOfWeek(endOfMonth(windowDate)),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- windowKey is the identity of windowDate that matters here
    [windowKey]
  );

  /**
   * `navigate` separates the two ways the date moves. A deliberate jump -- a
   * strip tap, Today, the month picker, a swipe -- moves the window, tells the
   * parent (which owns the fetch), pins the day so it survives being empty, and
   * scrolls to it. Scroll-sync only slides the strip's highlight to keep up with
   * the list; doing any of the rest of it would rebuild or re-scroll the agenda
   * under the user's own gesture.
   */
  const goToDate = useCallback(
    (date: Date, { navigate }: { navigate: boolean }) => {
      setSelectedDate(date);
      if (!navigate) return;
      setWindowDate(date);
      setPinnedDate(date);
      setPendingScroll(date);
      handlers.onDateChange(date);
    },
    [handlers]
  );

  const handleDateSelect = useCallback(
    (date: Date) => {
      goToDate(date, { navigate: true });
      setIsStripExpanded(false);
    },
    [goToDate]
  );

  const handleVisibleDateChange = useCallback(
    (date: Date) => goToDate(date, { navigate: false }),
    [goToDate]
  );

  const handleMonthSelect = useCallback(
    (date: Date) => {
      goToDate(date, { navigate: true });
      setIsMonthPickerOpen(false);
    },
    [goToDate]
  );

  const handleTodayClick = useCallback(() => {
    goToDate(new Date(), { navigate: true });
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
    goToDate(nextDate, { navigate: true });
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
