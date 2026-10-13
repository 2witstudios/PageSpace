'use client';

import type { ReactNode } from 'react';

export type UserCalendarChip = {
  readonly key: string;
  readonly name: string;
  /** The calendar's colour swatch, a Tailwind background class. */
  readonly dotClass: string;
  readonly visible: boolean;
};

export type UserCalendarChipsProps = {
  readonly calendars: readonly UserCalendarChip[];
  readonly onToggleCalendar: (key: string) => void;
  readonly userEventsVisible: boolean;
  readonly agentEventsVisible: boolean;
  readonly onToggleUserEvents: () => void;
  readonly onToggleAgentEvents: () => void;
  readonly showTasks: boolean;
  readonly onToggleTasks: () => void;
};

const chipClass = (pressed: boolean): string =>
  `flex h-head-control flex-none cursor-pointer items-center gap-2 rounded-round border-0 px-2.5 text-xs font-medium ${
    pressed ? 'bg-accent-soft text-ink' : 'bg-transparent text-ink-faint hover:bg-fill'
  }`;

/**
 * The user calendar's filter row (C-Account-Calendar): one aria-pressed chip per calendar, then the
 * User events, Agent events and Show tasks toggles. It replaces the classic calendars sidebar.
 */
export function UserCalendarChips({
  calendars,
  onToggleCalendar,
  userEventsVisible,
  agentEventsVisible,
  onToggleUserEvents,
  onToggleAgentEvents,
  showTasks,
  onToggleTasks,
}: UserCalendarChipsProps): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
      <div role="group" aria-label="Calendars" className="flex flex-wrap items-center gap-2">
        {calendars.map((calendar) => (
          <button
            key={calendar.key}
            type="button"
            aria-pressed={calendar.visible}
            className={chipClass(calendar.visible)}
            onClick={() => onToggleCalendar(calendar.key)}
          >
            <span aria-hidden="true" className={`size-2 rounded-full ${calendar.visible ? calendar.dotClass : 'bg-fill'}`} />
            {calendar.name}
          </button>
        ))}
      </div>
      <span aria-hidden="true" className="mx-1 h-4 border-l border-hairline" />
      <div role="group" aria-label="Event types" className="flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={userEventsVisible} className={chipClass(userEventsVisible)} onClick={onToggleUserEvents}>
          User events
        </button>
        <button type="button" aria-pressed={agentEventsVisible} className={chipClass(agentEventsVisible)} onClick={onToggleAgentEvents}>
          Agent events
        </button>
        <button type="button" aria-pressed={showTasks} className={chipClass(showTasks)} onClick={onToggleTasks}>
          Show tasks
        </button>
      </div>
    </div>
  );
}
