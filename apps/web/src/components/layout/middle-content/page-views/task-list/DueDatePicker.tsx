'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Calendar as CalendarIcon, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DueDatePickerProps {
  currentDate: string | null;
  onSelect: (date: Date | null) => void;
  disabled?: boolean;
}

export function DueDatePicker({
  currentDate,
  onSelect,
  disabled = false,
}: DueDatePickerProps) {
  const [open, setOpen] = useState(false);

  const date = currentDate ? new Date(currentDate) : undefined;
  const now = new Date();

  // Calculate color based on due date
  const getDateStyle = () => {
    if (!date) return 'text-muted-foreground';
    const diffDays = Math.ceil(
      (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diffDays < 0) return 'text-red-600 font-medium';
    if (diffDays <= 3) return 'text-amber-600';
    return 'text-muted-foreground';
  };

  const handleSelect = (selectedDate: Date | undefined) => {
    onSelect(selectedDate || null);
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(null);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          className={cn(
            'h-8 justify-start px-2 font-normal',
            getDateStyle(),
            disabled && 'pointer-events-none'
          )}
        >
          <CalendarIcon className="mr-1 h-3 w-3" />
          {date ? (
            <span className="flex items-center gap-1">
              {format(date, 'MMM d')}
              {!disabled && (
                <X
                  className="h-3 w-3 ml-1 hover:text-destructive cursor-pointer"
                  onClick={handleClear}
                />
              )}
            </span>
          ) : (
            <span>Set date</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={date} onSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  );
}
