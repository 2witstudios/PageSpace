// A due date between the date field and the task routes. The field holds a
// calendar day; PATCH takes an instant. The day is sent as noon UTC, so it
// reads as the same day wherever the viewer is, from UTC−11 to UTC+11.

/** The calendar day the date field shows for a due date; empty for none. */
export const dueDay = (dueDate: string | null): string => (dueDate === null ? '' : dueDate.slice(0, 10));

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The instant PATCH is sent for a day from the date field; null clears it, as does anything not a day. */
export const dueDateFor = (day: string): string | null =>
  DAY.test(day) && !Number.isNaN(Date.parse(day)) ? `${day}T12:00:00.000Z` : null;
