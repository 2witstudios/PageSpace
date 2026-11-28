/** The event types a calendar event can carry (calendar_events.color), in the board's order. */
export const calendarEventTypes = [
  { key: 'default', label: 'Default' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'deadline', label: 'Deadline' },
  { key: 'focus', label: 'Focus' },
  { key: 'personal', label: 'Personal' },
  { key: 'travel', label: 'Travel' },
] as const;
