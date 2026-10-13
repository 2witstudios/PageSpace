'use client';

import type { ReactNode } from 'react';
import type { CalendarViewMode } from '@/retained/components/calendar/calendar-types';
import { renderIcon } from '../../components/icon/icon.render';
import { headControlClass } from '../../frame/controls/controls-class';
import { ToolbarStrip } from '../../frame/toolbar-strip/toolbar-strip';
import { calendarRangeLabel, stepUnit } from '../calendar/calendar-state';

const viewNames: Readonly<Record<CalendarViewMode, string>> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  agenda: 'Agenda',
};

const textControlClass =
  'flex h-head-control flex-none cursor-pointer items-center rounded-md border-0 bg-transparent px-2 text-sm text-ink-muted no-underline hover:bg-fill hover:text-ink hover:no-underline';

/** The board's order: Month, Week, Day, Agenda. */
const viewOrder: readonly CalendarViewMode[] = ['month', 'week', 'day', 'agenda'];

const viewControlClass = (selected: boolean): string =>
  `${textControlClass} ${selected ? 'bg-accent-soft text-ink' : ''}`;

export type UserCalendarToolbarProps = {
  readonly view: CalendarViewMode;
  readonly date: Date;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onToday: () => void;
  readonly onView: (view: CalendarViewMode) => void;
  readonly onNewEvent: () => void;
};

/**
 * The 44px strip over the user calendar (C-Account-Calendar): the range, Previous, Next, Today,
 * the View group and New event. It stands in for the grid's own header, which the embedded
 * calendar does not draw.
 */
export function UserCalendarToolbar({ view, date, onStep, onToday, onView, onNewEvent }: UserCalendarToolbarProps): ReactNode {
  const unit = stepUnit(view);
  return (
    <ToolbarStrip label="Calendar">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{calendarRangeLabel(view, date)}</span>
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
        {viewOrder.map((option) => (
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
      <button type="button" className={`${textControlClass} ml-1 bg-accent-soft text-ink`} onClick={onNewEvent}>
        New event
      </button>
    </ToolbarStrip>
  );
}
