'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  addYears,
  subYears,
  setMonth,
  setYear,
  setDate,
  getDaysInMonth,
} from 'date-fns';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { isToday } from './calendar-types';

interface MobileMonthPickerProps {
  isOpen: boolean;
  onClose: () => void;
  selectedDate: Date;
  onSelect: (date: Date) => void;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

type PickerView = 'calendar' | 'months' | 'years';

export function MobileMonthPicker({
  isOpen,
  onClose,
  selectedDate,
  onSelect,
}: MobileMonthPickerProps) {
  const [viewDate, setViewDate] = useState(selectedDate);
  const [pickerView, setPickerView] = useState<PickerView>('calendar');

  // Reset viewDate to selectedDate when picker opens
  useEffect(() => {
    if (isOpen) {
      setViewDate(selectedDate);
      setPickerView('calendar');
    }
  }, [isOpen, selectedDate]);

  // Calculate calendar days for the current view
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(viewDate);
    const monthEnd = endOfMonth(viewDate);
    const calendarStart = startOfWeek(monthStart);
    const calendarEnd = endOfWeek(monthEnd);
    return eachDayOfInterval({ start: calendarStart, end: calendarEnd });
  }, [viewDate]);

  // Group days into weeks
  const weeks = useMemo(() => {
    const result: Date[][] = [];
    for (let i = 0; i < calendarDays.length; i += 7) {
      result.push(calendarDays.slice(i, i + 7));
    }
    return result;
  }, [calendarDays]);

  // Generate year options (10 years before and after current)
  const yearOptions = useMemo(() => {
    const currentYear = viewDate.getFullYear();
    const years: number[] = [];
    for (let i = currentYear - 10; i <= currentYear + 10; i++) {
      years.push(i);
    }
    return years;
  }, [viewDate]);

  const handlePrevMonth = () => {
    setViewDate(subMonths(viewDate, 1));
  };

  const handleNextMonth = () => {
    setViewDate(addMonths(viewDate, 1));
  };

  const handlePrevYear = () => {
    setViewDate(subYears(viewDate, 1));
  };

  const handleNextYear = () => {
    setViewDate(addYears(viewDate, 1));
  };

  const handleDaySelect = (day: Date) => {
    onSelect(day);
  };

  const handleMonthSelect = (monthIndex: number) => {
    // Clamp day to avoid overflow (e.g., Jan 31 -> Feb should stay in Feb)
    const targetDate = setMonth(setDate(viewDate, 1), monthIndex);
    const maxDay = getDaysInMonth(targetDate);
    const clampedDay = Math.min(viewDate.getDate(), maxDay);
    setViewDate(setDate(targetDate, clampedDay));
    setPickerView('calendar');
  };

  const handleYearSelect = (year: number) => {
    // Clamp day to avoid overflow (e.g., Feb 29 in leap year -> non-leap year)
    const targetDate = setYear(setDate(viewDate, 1), year);
    const maxDay = getDaysInMonth(targetDate);
    const clampedDay = Math.min(viewDate.getDate(), maxDay);
    setViewDate(setDate(targetDate, clampedDay));
    setPickerView('months');
  };

  const handleTodayClick = () => {
    const today = new Date();
    setViewDate(today);
    onSelect(today);
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="h-[70vh] rounded-t-xl">
        <SheetHeader className="pb-2">
          <SheetTitle>Select Date</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col h-full pb-6">
          {/* Navigation header */}
          <div className="flex items-center justify-between py-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={pickerView === 'years' ? handlePrevYear : handlePrevMonth}
              aria-label={pickerView === 'years' ? 'Previous year' : 'Previous month'}
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>

            <div className="flex items-center gap-2">
              {pickerView === 'calendar' && (
                <>
                  <Button
                    variant="ghost"
                    className="font-semibold"
                    onClick={() => setPickerView('months')}
                  >
                    {format(viewDate, 'MMMM')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="font-semibold"
                    onClick={() => setPickerView('years')}
                  >
                    {format(viewDate, 'yyyy')}
                  </Button>
                </>
              )}
              {pickerView === 'months' && (
                <Button
                  variant="ghost"
                  className="font-semibold"
                  onClick={() => setPickerView('years')}
                >
                  {format(viewDate, 'yyyy')}
                </Button>
              )}
              {pickerView === 'years' && (
                <span className="font-semibold">
                  {yearOptions[0]} - {yearOptions[yearOptions.length - 1]}
                </span>
              )}
            </div>

            <Button
              variant="ghost"
              size="icon"
              onClick={pickerView === 'years' ? handleNextYear : handleNextMonth}
              aria-label={pickerView === 'years' ? 'Next year' : 'Next month'}
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>

          {/* Calendar/Month/Year view */}
          <div className="flex-1 overflow-auto">
            {pickerView === 'calendar' && (
              <div>
                {/* Weekday headers */}
                <div className="grid grid-cols-7 mb-2">
                  {WEEKDAYS.map((day, i) => (
                    <div
                      key={i}
                      className="text-center text-sm font-medium text-muted-foreground py-2"
                    >
                      {day}
                    </div>
                  ))}
                </div>

                {/* Calendar grid */}
                <div className="space-y-1">
                  {weeks.map((week, weekIndex) => (
                    <div key={weekIndex} className="grid grid-cols-7">
                      {week.map((day) => {
                        const isCurrentMonth = isSameMonth(day, viewDate);
                        const isTodayDate = isToday(day);
                        const isSelected = isSameDay(day, selectedDate);

                        return (
                          <button
                            key={day.toISOString()}
                            className={cn(
                              'h-10 w-full flex items-center justify-center rounded-full text-sm transition-colors',
                              !isCurrentMonth && 'text-muted-foreground/50',
                              isSelected && 'bg-primary text-primary-foreground',
                              !isSelected && isTodayDate && 'bg-primary/20 text-primary font-semibold',
                              !isSelected && !isTodayDate && isCurrentMonth && 'hover:bg-muted'
                            )}
                            onClick={() => handleDaySelect(day)}
                          >
                            {format(day, 'd')}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {pickerView === 'months' && (
              <div className="grid grid-cols-3 gap-2 p-2">
                {MONTH_NAMES.map((month, index) => {
                  const isCurrentMonth =
                    index === viewDate.getMonth() &&
                    viewDate.getFullYear() === new Date().getFullYear();
                  const isSelected =
                    index === selectedDate.getMonth() &&
                    viewDate.getFullYear() === selectedDate.getFullYear();

                  return (
                    <button
                      key={month}
                      className={cn(
                        'py-4 px-2 rounded-lg text-sm font-medium transition-colors',
                        isSelected && 'bg-primary text-primary-foreground',
                        !isSelected && isCurrentMonth && 'bg-primary/20 text-primary',
                        !isSelected && !isCurrentMonth && 'hover:bg-muted'
                      )}
                      onClick={() => handleMonthSelect(index)}
                    >
                      {month}
                    </button>
                  );
                })}
              </div>
            )}

            {pickerView === 'years' && (
              <div className="grid grid-cols-3 gap-2 p-2">
                {yearOptions.map((year) => {
                  const isCurrentYear = year === new Date().getFullYear();
                  const isSelected = year === selectedDate.getFullYear();

                  return (
                    <button
                      key={year}
                      className={cn(
                        'py-3 px-2 rounded-lg text-sm font-medium transition-colors',
                        isSelected && 'bg-primary text-primary-foreground',
                        !isSelected && isCurrentYear && 'bg-primary/20 text-primary',
                        !isSelected && !isCurrentYear && 'hover:bg-muted'
                      )}
                      onClick={() => handleYearSelect(year)}
                    >
                      {year}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer with Today button */}
          <div className="pt-4 border-t">
            <Button
              variant="outline"
              className="w-full"
              onClick={handleTodayClick}
            >
              Go to Today
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
