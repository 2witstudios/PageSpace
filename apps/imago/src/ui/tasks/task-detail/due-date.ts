// A due date between the date field and the task routes, with classic's
// semantics exactly. Classic's DueDatePicker shows the stored instant's day in
// the viewer's own zone, and stores a picked day as that day's local midnight
// (Date#toISOString of the picked Date). Imago does the same, so a date set in
// either app reads as the same day in both, for the same viewer.

const pad = (value: number): string => String(value).padStart(2, '0');

/** The viewer's local calendar day of a due date, as the date field takes it; empty for none. */
export const dueDay = (dueDate: string | null): string => {
  if (dueDate === null) return '';
  const at = new Date(dueDate);
  if (Number.isNaN(at.getTime())) return '';
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant PATCH is sent for a day from the date field: its local
 * midnight, as classic sends. Null clears it, as does anything not a real day.
 */
export const dueDateFor = (day: string): string | null => {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const midnight = new Date(year, month - 1, date);
  const real = midnight.getFullYear() === year && midnight.getMonth() === month - 1 && midnight.getDate() === date;
  return real ? midnight.toISOString() : null;
};
