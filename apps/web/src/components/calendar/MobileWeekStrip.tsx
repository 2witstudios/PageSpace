'use client';

import { useMemo, useRef, useEffect } from 'react';
import {
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  addWeeks,
  subWeeks,
  isSameDay,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CalendarEvent,
  TaskWithDueDate,
  getEventsForDay,
  getTasksForDay,
  isToday,
  getEventColors,
} from './calendar-types';

interface MobileWeekStripProps {
  currentDate: Date;
  selectedDate: Date;
  events: CalendarEvent[];
  tasks: TaskWithDueDate[];
  onDateSelect: (date: Date) => void;
  onWeekChange: (date: Date) => void;
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function MobileWeekStrip({
  currentDate,
  selectedDate,
  events,
  tasks,
  onDateSelect,
  onWeekChange,
}: MobileWeekStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Calculate the week days
  const weekDays = useMemo(() => {
    const weekStart = startOfWeek(currentDate);
    const weekEnd = endOfWeek(currentDate);
    return eachDayOfInterval({ start: weekStart, end: weekEnd });
  }, [currentDate]);

  // Scroll selected day into view on mount
  useEffect(() => {
    const selectedIndex = weekDays.findIndex((d) => isSameDay(d, selectedDate));
    if (selectedIndex !== -1 && scrollRef.current) {
      const dayElement = scrollRef.current.children[selectedIndex] as HTMLElement;
      if (dayElement) {
        dayElement.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [selectedDate, weekDays]);

  const handlePrevWeek = () => {
    onWeekChange(subWeeks(currentDate, 1));
  };

  const handleNextWeek = () => {
    onWeekChange(addWeeks(currentDate, 1));
  };

  return (
    <div className="bg-background border-b">
      {/* Month/Year header with week navigation */}
      <div className="flex items-center justify-between px-4 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handlePrevWeek}
          aria-label="Previous week"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">
          {format(currentDate, 'MMMM yyyy')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleNextWeek}
          aria-label="Next week"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Week days strip */}
      <div
        ref={scrollRef}
        className="flex justify-around px-2 pb-3"
      >
        {weekDays.map((day, index) => {
          const dayEvents = getEventsForDay(events, day);
          const dayTasks = getTasksForDay(tasks, day);
          const hasItems = dayEvents.length > 0 || dayTasks.length > 0;
          const isTodayDate = isToday(day);
          const isSelected = isSameDay(day, selectedDate);

          // Get the primary event color for the indicator
          const primaryEventColor = dayEvents.length > 0
            ? getEventColors(dayEvents[0].color).dot
            : null;

          return (
            <button
              key={day.toISOString()}
              className="flex flex-col items-center gap-1 min-w-[40px] py-1 rounded-lg transition-colors"
              onClick={() => onDateSelect(day)}
            >
              {/* Weekday label */}
              <span
                className={cn(
                  'text-xs font-medium',
                  isSelected ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                {WEEKDAY_LABELS[index]}
              </span>

              {/* Day number */}
              <div
                className={cn(
                  'w-9 h-9 flex items-center justify-center rounded-full text-sm font-semibold transition-all',
                  isSelected && 'bg-primary text-primary-foreground',
                  !isSelected && isTodayDate && 'bg-primary/20 text-primary',
                  !isSelected && !isTodayDate && 'hover:bg-muted'
                )}
              >
                {format(day, 'd')}
              </div>

              {/* Event indicator dots */}
              <div className="h-1.5 flex items-center justify-center gap-0.5">
                {hasItems && (
                  <>
                    {dayEvents.length > 0 && (
                      <div
                        className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          isSelected ? 'bg-primary-foreground/70' : primaryEventColor
                        )}
                      />
                    )}
                    {dayTasks.length > 0 && (
                      <div
                        className={cn(
                          'w-1.5 h-1.5 rounded-full',
                          isSelected ? 'bg-primary-foreground/50' : 'bg-muted-foreground/50'
                        )}
                      />
                    )}
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
