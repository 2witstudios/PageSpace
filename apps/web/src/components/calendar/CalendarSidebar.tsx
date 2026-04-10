'use client';

import { cn } from '@/lib/utils';
import type { EventColorConfig } from './calendar-types';

interface CalendarEntry {
  key: string;
  name: string;
  color: EventColorConfig;
  visible: boolean;
}

interface CalendarSidebarProps {
  calendars: CalendarEntry[];
  onToggle: (key: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  className?: string;
}

export function CalendarSidebar({
  calendars,
  onToggle,
  onShowAll,
  onHideAll,
  className,
}: CalendarSidebarProps) {
  const hasCalendars = calendars.length > 0;
  const allVisible = hasCalendars && calendars.every((c) => c.visible);
  const noneVisible = hasCalendars && calendars.every((c) => !c.visible);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center justify-between px-1 mb-1">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          My Calendars
        </span>
        <button
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={allVisible ? () => onHideAll() : () => onShowAll()}
        >
          {allVisible ? 'Hide all' : 'Show all'}
        </button>
      </div>

      {calendars.map((cal) => (
        <div
          key={cal.key}
          role="button"
          tabIndex={0}
          onClick={() => onToggle(cal.key)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(cal.key); } }}
          className={cn(
            'flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer transition-colors',
            'hover:bg-muted/50',
            !cal.visible && 'opacity-50'
          )}
        >
          <span
            role="checkbox"
            aria-checked={cal.visible}
            aria-label={`Toggle ${cal.name}`}
            className={cn(
              'size-3.5 shrink-0 rounded-sm border transition-colors',
              cal.visible
                ? cn(cal.color.dot, 'border-transparent')
                : 'border-muted-foreground/40 bg-transparent'
            )}
          >
            {cal.visible && (
              <svg viewBox="0 0 14 14" className="size-3.5 text-white">
                <path
                  d="M11.5 3.5L5.5 9.5L2.5 6.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            )}
          </span>
          <span className="text-sm truncate">{cal.name}</span>
        </div>
      ))}

      {noneVisible && (
        <p className="text-xs text-muted-foreground px-1.5 py-2">
          All calendars hidden
        </p>
      )}
    </div>
  );
}
