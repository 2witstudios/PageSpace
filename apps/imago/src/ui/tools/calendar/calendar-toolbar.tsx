'use client';

import type { ReactNode } from 'react';
import type { CalendarViewMode } from '@/retained/components/calendar/calendar-types';
import { renderIcon } from '../../components/icon/icon.render';
import { headControlClass } from '../../frame/controls/controls-class';
import { ToolbarStrip } from '../../frame/toolbar-strip/toolbar-strip';
import { calendarRangeLabel, calendarViews, stepUnit } from './calendar-state';

const viewNames: Readonly<Record<CalendarViewMode, string>> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  agenda: 'Agenda',
};

const textControlClass =
  'flex h-head-control flex-none cursor-pointer items-center rounded-md border-0 bg-transparent px-2 text-sm text-ink-muted no-underline hover:bg-fill hover:text-ink hover:no-underline';

const viewControlClass = (selected: boolean): string =>
  `${textControlClass} ${selected ? 'bg-accent-soft text-ink' : ''}`;

export type CalendarToolbarProps = {
  readonly view: CalendarViewMode;
  readonly date: Date;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onToday: () => void;
  readonly onView: (view: CalendarViewMode) => void;
};

/** The 44px calendar strip (C-Drive-Calendar): the range, Previous, Next, Today and the View group. */
export function CalendarToolbar({ view, date, onStep, onToday, onView }: CalendarToolbarProps): ReactNode {
  const unit = stepUnit(view);
  return (
    <ToolbarStrip label="Calendar">
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{calendarRangeLabel(view, date)}</h2>
      <button type="button" className={headControlClass} aria-label={`Previous ${unit}`} title={`Previous ${unit}`} onClick={() => onStep(-1)}>
        {renderIcon({ name: 'chevronLeft', size: 14 })}
      </button>
      <button type="button" className={headControlClass} aria-label={`Next ${unit}`} title={`Next ${unit}`} onClick={() => onStep(1)}>
        {renderIcon({ name: 'chevronRight', size: 14 })}
      </button>
      <button type="button" className={textControlClass} onClick={onToday}>
        Today
      </button>
      <div role="group" aria-label="View" className="flex flex-none items-center gap-px">
        {calendarViews.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === view}
            className={viewControlClass(option === view)}
            onClick={() => onView(option)}
          >
            {viewNames[option]}
          </button>
        ))}
      </div>
    </ToolbarStrip>
  );
}
