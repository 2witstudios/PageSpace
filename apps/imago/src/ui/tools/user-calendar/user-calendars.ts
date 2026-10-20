import { getDriveCalendarColor } from '@/retained/components/calendar/calendar-types';

/** One calendar of the user calendar: Personal, or a drive. */
export type UserCalendar = {
  readonly key: string;
  readonly name: string;
  /** The calendar's colour swatch, a Tailwind background class. */
  readonly dotClass: string;
};

/**
 * The user calendar's calendars: Personal, then every drive the user sees, each in the colour
 * the grid draws its events in. The middle's chips and Home's Calendar pane both list these.
 */
export const userCalendars = (drives: readonly { readonly id: string; readonly name: string }[]): UserCalendar[] => {
  const driveIds = drives.map((drive) => drive.id);
  return [
    { key: 'personal', name: 'Personal', dotClass: getDriveCalendarColor(null, driveIds).dot },
    ...drives.map((drive) => ({ key: drive.id, name: drive.name, dotClass: getDriveCalendarColor(drive.id, driveIds).dot })),
  ];
};
