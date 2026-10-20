'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { renderIcon } from '../icon/icon.render';
import {
  addMonths,
  allowed,
  dayForKey,
  dayName,
  inMonth,
  isDay,
  monthGrid,
  monthOf,
  monthTitle,
  quickPicks,
  weekdayHeads,
  weekdayShort,
  type Month,
} from './calendar';
import {
  calendarDayClass,
  calendarGridClass,
  calendarHeadClass,
  calendarNavClass,
  calendarRowClass,
  calendarTitleClass,
  calendarWeekdayClass,
  datePickerClass,
  datePickerClearClass,
  datePickerDoneClass,
  datePickerFootClass,
  quickPickClass,
  quickPickDayClass,
  quickPicksClass,
} from './date-picker-class';

export type DatePickerProps = {
  /** What is being picked, such as "Due date": names the calendar grid. */
  readonly label: string;
  /** The chosen day, YYYY-MM-DD; empty for none. */
  readonly value: string;
  /** The viewer's own day, YYYY-MM-DD. */
  readonly today: string;
  /** The first and last days that may be chosen, each when given. */
  readonly min?: string;
  readonly max?: string;
  /** Void action: a day was chosen, or (null) the date cleared. */
  readonly pick: (day: string | null) => void;
  /** Void action: Done. */
  readonly done: () => void;
};

/**
 * Quick picks, a month's calendar and Clear / Done. The grid keeps one day in
 * the tab order: arrows move by a day or a week, Home and End to the week's
 * ends, Page Up and Down by a month, and Enter or Space chooses.
 */
export function DatePicker({ label, value, today, min, max, pick, done }: DatePickerProps): ReactNode {
  const start = isDay(value) ? value : today;
  const [focused, setFocused] = useState(start);
  const [month, setMonth] = useState<Month>(monthOf(start));
  const grid = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`)?.focus();
  }, [focused]);

  const showMonth = (next: Month) => {
    setMonth(next);
    if (!inMonth(focused, next)) setFocused(`${next.year}-${String(next.month + 1).padStart(2, '0')}-01`);
  };

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, day: string) => {
    const next = dayForKey(day, event.key);
    if (next === null) return;
    event.preventDefault();
    moved.current = true;
    setFocused(next);
    if (!inMonth(next, month)) setMonth(monthOf(next));
  };

  return (
    <div className={datePickerClass}>
      <div className={quickPicksClass}>
        {quickPicks(today).map((choice) => (
          <button
            key={choice.label}
            type="button"
            className={quickPickClass}
            disabled={!allowed(choice.day, min, max)}
            onClick={() => pick(choice.day)}
          >
            {choice.label}
            <span className={quickPickDayClass}>{weekdayShort(choice.day)}</span>
          </button>
        ))}
      </div>
      <div className={calendarHeadClass}>
        <span className={calendarTitleClass} aria-live="polite">
          {monthTitle(month)}
        </span>
        <span className="flex items-center gap-1">
          <button type="button" aria-label="Previous month" className={calendarNavClass} onClick={() => showMonth(addMonths(month, -1))}>
            {renderIcon({ name: 'chevronLeft', size: 14 })}
          </button>
          <button type="button" aria-label="Next month" className={calendarNavClass} onClick={() => showMonth(addMonths(month, 1))}>
            {renderIcon({ name: 'chevronRight', size: 14 })}
          </button>
        </span>
      </div>
      <div ref={grid} role="grid" aria-label={`${label}, ${monthTitle(month)}`} className={calendarGridClass}>
        <div role="row" className={calendarRowClass}>
          {weekdayHeads.map((head) => (
            <span key={head.name} role="columnheader" aria-label={head.name} className={calendarWeekdayClass}>
              {head.short}
            </span>
          ))}
        </div>
        {monthGrid(month).map((week) => (
          <div key={week[0]} role="row" className={calendarRowClass}>
            {week.map((day) => (
              <span key={day} role="gridcell" aria-selected={day === value}>
                <button
                  type="button"
                  data-day={day}
                  aria-label={dayName(day)}
                  aria-current={day === today ? 'date' : undefined}
                  tabIndex={day === focused ? 0 : -1}
                  disabled={!allowed(day, min, max)}
                  className={calendarDayClass({ selected: day === value, today: day === today, outside: !inMonth(day, month) })}
                  onClick={() => pick(day)}
                  onKeyDown={(event) => onKey(event, day)}
                >
                  {Number(day.slice(8, 10))}
                </button>
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className={datePickerFootClass}>
        {value === '' ? null : (
          <button type="button" className={datePickerClearClass} onClick={() => pick(null)}>
            Clear date
          </button>
        )}
        <button type="button" className={datePickerDoneClass} onClick={done}>
          Done
        </button>
      </div>
    </div>
  );
}
