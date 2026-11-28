'use client';

import type { ReactNode } from 'react';
import { addDays, addMonths, addWeeks, endOfMonth, format, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek } from 'date-fns';
import { renderIcon } from '../../components/icon/icon.render';
import { headControlClass } from '../../frame/controls/controls-class';

/** The weeks (Monday-first) that cover the month of `anchor`: the rows the mini month draws. */
export function miniMonthWeeks(anchor: Date): Date[][] {
  const last = endOfMonth(anchor);
  const weeks: Date[][] = [];
  for (let cursor = startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 }); weeks.length === 0 || cursor <= last; cursor = addWeeks(cursor, 1)) {
    weeks.push(Array.from({ length: 7 }, (_, index) => addDays(cursor, index)));
  }
  return weeks;
}

const weekdayLetters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export type MiniMonthProps = {
  /** The calendar's selected day; its month is shown. */
  readonly date: Date;
  readonly onSelect: (date: Date) => void;
};

/** The pane's month picker (C-Drive-Calendar: "October 2026" with Previous and Next month). */
export function MiniMonth({ date, onSelect }: MiniMonthProps): ReactNode {
  const heading = format(date, 'MMMM yyyy');
  return (
    <div className="flex flex-col gap-1 pb-2">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{heading}</span>
        <button type="button" className={headControlClass} aria-label="Previous month" title="Previous month" onClick={() => onSelect(addMonths(date, -1))}>
          {renderIcon({ name: 'chevronLeft', size: 12 })}
        </button>
        <button type="button" className={headControlClass} aria-label="Next month" title="Next month" onClick={() => onSelect(addMonths(date, 1))}>
          {renderIcon({ name: 'chevronRight', size: 12 })}
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px text-center text-2xs text-ink-faint" aria-hidden="true">
        {weekdayLetters.map((letter, index) => (
          <span key={index}>{letter}</span>
        ))}
      </div>
      {miniMonthWeeks(date).map((week) => (
        <div key={week[0]?.toISOString()} className="grid grid-cols-7 gap-px">
          {week.map((day) => {
            const selected = isSameDay(day, date);
            const inMonth = isSameMonth(day, date);
            const tone = selected ? 'bg-accent-soft text-ink' : inMonth ? 'text-ink-muted hover:bg-fill hover:text-ink' : 'text-ink-faint hover:bg-fill';
            return (
              <button
                key={day.toISOString()}
                type="button"
                aria-label={format(day, 'MMMM d, yyyy')}
                aria-pressed={selected}
                aria-current={isToday(day) ? 'date' : undefined}
                onClick={() => onSelect(day)}
                className={`flex h-6 cursor-pointer items-center justify-center rounded-md border-0 text-2xs no-underline ${tone} ${isToday(day) && !selected ? 'text-accent-deep' : ''}`}
              >
                {format(day, 'd')}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
