'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  format,
  addDays,
  subDays,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isTomorrow,
  isYesterday,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { ChevronDown, ListTodo, CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileWeekStrip } from './MobileWeekStrip';
import { MobileDayAgenda } from './MobileDayAgenda';
import { MobileMonthPicker } from './MobileMonthPicker';
import {
  CalendarEvent,
  CalendarHandlers,
  TaskWithDueDate,
  getEventsForDay,
  getTasksForDay,
  getEventColors,
  TASK_OVERLAY_STYLE,
  isToday,
} from './calendar-types';

interface MobileCalendarViewProps {
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
  showTasks: boolean;
  onShowTasksChange: (show: boolean) => void;
  isLoading?: boolean;
  currentDate?: Date;
}

type MobileViewMode = 'day' | 'month';

export function MobileCalendarView({
  events,
  tasks,
  handlers,
  showTasks,
  onShowTasksChange,
  isLoading,
  currentDate: parentDate,
}: MobileCalendarViewProps) {
  const [selectedDate, setSelectedDate] = useState(() => parentDate ?? new Date());
  const [currentWeekStart, setCurrentWeekStart] = useState(() =>
    startOfWeek(parentDate ?? new Date())
  );

  // Sync with parent date when it changes externally
  useEffect(() => {
    if (parentDate && !isSameDay(parentDate, selectedDate)) {
      setSelectedDate(parentDate);
      setCurrentWeekStart(startOfWeek(parentDate));
    }
  }, [parentDate]);
  const [mobileView, setMobileView] = useState<MobileViewMode>('day');
  const [isMonthPickerOpen, setIsMonthPickerOpen] = useState(false);

  // Touch handling for swipe navigation
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Handle date selection from week strip
  const handleDateSelect = useCallback((date: Date) => {
    setSelectedDate(date);
    handlers.onDateChange(date);
  }, [handlers]);

  // Handle week change from week strip navigation
  const handleWeekChange = useCallback((date: Date) => {
    const weekStart = startOfWeek(date);
    setCurrentWeekStart(weekStart);
    const newDate = addDays(weekStart, selectedDate.getDay());
    setSelectedDate(newDate);
    handlers.onDateChange(newDate);
  }, [selectedDate, handlers]);

  // Handle month selection from month picker
  const handleMonthSelect = useCallback((date: Date) => {
    setSelectedDate(date);
    setCurrentWeekStart(startOfWeek(date));
    handlers.onDateChange(date);
    setIsMonthPickerOpen(false);
  }, [handlers]);

  // Swipe to change day
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (touchStartX.current === null || touchEndX.current === null) return;

    const diff = touchStartX.current - touchEndX.current;
    const minSwipeDistance = 50;

    if (Math.abs(diff) > minSwipeDistance) {
      if (diff > 0) {
        // Swipe left - next day
        const nextDate = addDays(selectedDate, 1);
        setSelectedDate(nextDate);
        // Update week if needed
        if (!isSameDay(startOfWeek(nextDate), currentWeekStart)) {
          setCurrentWeekStart(startOfWeek(nextDate));
        }
        handlers.onDateChange(nextDate);
      } else {
        // Swipe right - previous day
        const prevDate = subDays(selectedDate, 1);
        setSelectedDate(prevDate);
        // Update week if needed
        if (!isSameDay(startOfWeek(prevDate), currentWeekStart)) {
          setCurrentWeekStart(startOfWeek(prevDate));
        }
        handlers.onDateChange(prevDate);
      }
    }

    touchStartX.current = null;
    touchEndX.current = null;
  }, [selectedDate, currentWeekStart, handlers]);

  // Jump to today
  const handleTodayClick = useCallback(() => {
    const today = new Date();
    setSelectedDate(today);
    setCurrentWeekStart(startOfWeek(today));
    handlers.onDateChange(today);
  }, [handlers]);

  // Update week strip when selected date changes externally
  useEffect(() => {
    const weekStart = startOfWeek(selectedDate);
    if (!isSameDay(weekStart, currentWeekStart)) {
      setCurrentWeekStart(weekStart);
    }
  }, [selectedDate, currentWeekStart]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Mobile header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-background">
        {/* Month/Year dropdown trigger */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-1 px-2 font-semibold">
              {format(selectedDate, 'MMM yyyy')}
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={handleTodayClick}>
              Go to Today
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setIsMonthPickerOpen(true)}>
              Choose Month...
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Right controls */}
        <div className="flex items-center gap-1">
          {/* View mode toggle */}
          <div className="flex items-center bg-muted rounded-md p-0.5">
            <button
              onClick={() => setMobileView('day')}
              className={cn(
                'p-1.5 rounded transition-colors',
                mobileView === 'day'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground'
              )}
              title="Day view"
              aria-label="Day view"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
            <button
              onClick={() => setMobileView('month')}
              className={cn(
                'p-1.5 rounded transition-colors',
                mobileView === 'month'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground'
              )}
              title="Month view"
              aria-label="Month view"
            >
              <ListTodo className="h-4 w-4" />
            </button>
          </div>

          {/* Tasks toggle */}
          <Toggle
            pressed={showTasks}
            onPressedChange={onShowTasksChange}
            size="sm"
            aria-label="Show tasks"
            className="data-[state=on]:bg-primary/10"
          >
            Tasks
          </Toggle>
        </div>
      </div>

      {/* Week strip */}
      <MobileWeekStrip
        currentDate={currentWeekStart}
        selectedDate={selectedDate}
        events={events}
        tasks={showTasks ? tasks : []}
        onDateSelect={handleDateSelect}
        onWeekChange={handleWeekChange}
      />

      {/* Main content area with swipe support */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {mobileView === 'day' ? (
          <MobileDayAgenda
            selectedDate={selectedDate}
            events={events}
            tasks={tasks}
            handlers={handlers}
            showTasks={showTasks}
          />
        ) : (
          // Month agenda view - shows all events for the month
          <MobileMonthAgenda
            selectedDate={selectedDate}
            events={events}
            tasks={tasks}
            handlers={handlers}
            showTasks={showTasks}
            onDateSelect={handleDateSelect}
          />
        )}
      </div>

      {/* Month picker modal */}
      <MobileMonthPicker
        isOpen={isMonthPickerOpen}
        onClose={() => setIsMonthPickerOpen(false)}
        selectedDate={selectedDate}
        onSelect={handleMonthSelect}
      />
    </div>
  );
}

// Month agenda view - shows all events grouped by day
function MobileMonthAgenda({
  selectedDate,
  events,
  tasks,
  handlers,
  showTasks,
  onDateSelect,
}: {
  selectedDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  handlers: CalendarHandlers;
  showTasks: boolean;
  onDateSelect: (date: Date) => void;
}) {
  // Get all days in the current month with events/tasks
  const dayGroups = useMemo(() => {
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });

    return monthDays
      .map((day: Date) => ({
        date: day,
        events: getEventsForDay(events, day),
        tasks: showTasks ? getTasksForDay(tasks, day) : [],
      }))
      .filter((group: { events: CalendarEvent[]; tasks: TaskWithDueDate[] }) =>
        group.events.length > 0 || group.tasks.length > 0
      );
  }, [selectedDate, events, tasks, showTasks]);

  const formatRelativeDate = (date: Date) => {
    if (isToday(date)) return 'Today';
    if (isTomorrow(date)) return 'Tomorrow';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'EEEE, MMM d');
  };

  if (dayGroups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <p className="text-lg font-medium text-muted-foreground">No events this month</p>
        <p className="text-sm text-muted-foreground mt-1">
          Tap a day to add an event
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="p-4 space-y-4">
        {dayGroups.map((group: { date: Date; events: CalendarEvent[]; tasks: TaskWithDueDate[] }) => {
          const isTodayDate = isToday(group.date);
          const isSelected = isSameDay(group.date, selectedDate);

          return (
            <div key={group.date.toISOString()}>
              {/* Day header - tappable to select */}
              <button
                className={cn(
                  'flex items-center gap-3 w-full py-2 mb-2',
                  isSelected && 'text-primary'
                )}
                onClick={() => onDateSelect(group.date)}
              >
                <div
                  className={cn(
                    'w-10 h-10 flex items-center justify-center rounded-full font-bold text-sm',
                    isTodayDate
                      ? 'bg-primary text-primary-foreground'
                      : isSelected
                        ? 'bg-primary/20 text-primary'
                        : 'bg-muted'
                  )}
                >
                  {format(group.date, 'd')}
                </div>
                <span className="font-medium">{formatRelativeDate(group.date)}</span>
              </button>

              {/* Events for this day */}
              <div className="space-y-2 pl-13">
                {group.events.map((event: CalendarEvent) => {
                  const colors = getEventColors(event.color);
                  return (
                    <button
                      key={event.id}
                      className={cn(
                        'w-full text-left p-3 rounded-lg border-l-4',
                        colors.bg,
                        colors.border,
                        'active:scale-[0.98] transition-transform'
                      )}
                      onClick={() => handlers.onEventClick(event)}
                    >
                      <div className="font-medium truncate">{event.title}</div>
                      {!event.allDay && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {format(new Date(event.startAt), 'h:mm a')}
                        </div>
                      )}
                    </button>
                  );
                })}

                {group.tasks.map((task: TaskWithDueDate) => (
                  <button
                    key={task.id}
                    className={cn(
                      'w-full text-left p-3 rounded-lg border-l-4',
                      TASK_OVERLAY_STYLE.bg,
                      TASK_OVERLAY_STYLE.border,
                      'active:scale-[0.98] transition-transform'
                    )}
                    onClick={() => handlers.onTaskClick?.(task)}
                  >
                    <div className="flex items-center gap-2">
                      <span className={task.status === 'completed' ? 'text-green-600' : ''}>
                        {task.status === 'completed' ? '✓' : '☐'}
                      </span>
                      <span
                        className={cn(
                          'truncate',
                          task.status === 'completed' && 'line-through text-muted-foreground'
                        )}
                      >
                        {task.title}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
