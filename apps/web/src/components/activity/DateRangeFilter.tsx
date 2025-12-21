'use client';

import { useState } from 'react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { Calendar as CalendarIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface DateRangeFilterProps {
  startDate?: Date;
  endDate?: Date;
  onDateChange: (startDate?: Date, endDate?: Date) => void;
}

type PresetOption = {
  label: string;
  getValue: () => { start: Date; end: Date };
};

const presets: PresetOption[] = [
  {
    label: 'Today',
    getValue: () => ({
      start: startOfDay(new Date()),
      end: endOfDay(new Date()),
    }),
  },
  {
    label: 'Last 7 days',
    getValue: () => ({
      start: startOfDay(subDays(new Date(), 7)),
      end: endOfDay(new Date()),
    }),
  },
  {
    label: 'Last 30 days',
    getValue: () => ({
      start: startOfDay(subDays(new Date(), 30)),
      end: endOfDay(new Date()),
    }),
  },
  {
    label: 'Last 90 days',
    getValue: () => ({
      start: startOfDay(subDays(new Date(), 90)),
      end: endOfDay(new Date()),
    }),
  },
];

export function DateRangeFilter({ startDate, endDate, onDateChange }: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);

  const handlePresetClick = (preset: PresetOption) => {
    const { start, end } = preset.getValue();
    onDateChange(start, end);
    setOpen(false);
  };

  const handleClear = () => {
    onDateChange(undefined, undefined);
  };

  const hasDateRange = startDate || endDate;

  const getDisplayText = () => {
    if (!startDate && !endDate) {
      return 'All time';
    }
    if (startDate && endDate) {
      const sameDay = format(startDate, 'yyyy-MM-dd') === format(endDate, 'yyyy-MM-dd');
      if (sameDay) {
        return format(startDate, 'MMM d, yyyy');
      }
      return `${format(startDate, 'MMM d')} - ${format(endDate, 'MMM d, yyyy')}`;
    }
    if (startDate) {
      return `From ${format(startDate, 'MMM d, yyyy')}`;
    }
    return `Until ${format(endDate!, 'MMM d, yyyy')}`;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            'w-[200px] justify-start text-left font-normal',
            !hasDateRange && 'text-muted-foreground'
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          <span className="truncate">{getDisplayText()}</span>
          {hasDateRange && (
            <X
              className="ml-auto h-4 w-4 shrink-0 opacity-50 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                handleClear();
              }}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
          {/* Presets */}
          <div className="border-r p-2 space-y-1">
            {presets.map((preset) => (
              <Button
                key={preset.label}
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => handlePresetClick(preset)}
              >
                {preset.label}
              </Button>
            ))}
            {hasDateRange && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={handleClear}
              >
                Clear
              </Button>
            )}
          </div>
          {/* Calendar */}
          <div className="p-2">
            <Calendar
              mode="range"
              selected={{
                from: startDate,
                to: endDate,
              }}
              onSelect={(range) => {
                onDateChange(range?.from, range?.to);
              }}
              numberOfMonths={1}
              disabled={{ after: new Date() }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
