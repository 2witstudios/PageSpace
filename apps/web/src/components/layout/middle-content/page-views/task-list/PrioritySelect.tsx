'use client';

import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, Flag } from 'lucide-react';
import { cn } from '@/lib/utils';

const PRIORITY_CONFIG = {
  low: {
    label: 'Low',
    color: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  },
  medium: {
    label: 'Medium',
    color: 'bg-amber-100 text-amber-600 dark:bg-amber-900/50 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  },
  high: {
    label: 'High',
    color: 'bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400 border-red-200 dark:border-red-800',
  },
} as const;

type Priority = 'low' | 'medium' | 'high';

interface PrioritySelectProps {
  currentPriority: Priority;
  onSelect: (priority: Priority) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function PrioritySelect({
  currentPriority,
  onSelect,
  disabled = false,
  compact = false,
}: PrioritySelectProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (priority: Priority) => {
    onSelect(priority);
    setOpen(false);
  };

  const config = PRIORITY_CONFIG[currentPriority];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          className={cn(
            'justify-start px-2 font-normal',
            compact ? 'h-6 text-xs' : 'h-8',
            disabled && 'pointer-events-none'
          )}
        >
          {compact ? (
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0', config.color)}
            >
              {config.label}
            </Badge>
          ) : (
            <span className="flex items-center gap-1.5">
              <Flag className="h-3 w-3" />
              <Badge variant="outline" className={cn('text-xs', config.color)}>
                {config.label}
              </Badge>
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-32 p-1" align="start">
        <div className="flex flex-col gap-0.5">
          {(Object.entries(PRIORITY_CONFIG) as [Priority, typeof config][]).map(
            ([key, { label, color }]) => (
              <button
                key={key}
                type="button"
                onClick={() => handleSelect(key)}
                className={cn(
                  'w-full flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-muted transition-colors'
                )}
              >
                <Badge variant="outline" className={cn('text-xs', color)}>
                  {label}
                </Badge>
                {currentPriority === key && <Check className="h-4 w-4" />}
              </button>
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
