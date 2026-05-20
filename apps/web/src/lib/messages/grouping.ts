import { isToday, isYesterday, isThisWeek, format } from 'date-fns';

const GROUP_BREAK_MS = 5 * 60 * 1000;

export function formatMessageDate(date: Date | string): string {
  const d = new Date(date);
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  if (isThisWeek(d)) return format(d, 'EEEE');
  return format(d, 'MMMM d, yyyy');
}

export interface GroupableMessage {
  authorKey: string;
  createdAt: Date | string;
}

export function isFirstInGroup(
  current: GroupableMessage,
  previous: GroupableMessage | undefined,
): boolean {
  if (!previous) return true;
  if (current.authorKey !== previous.authorKey) return true;
  const currentDate = new Date(current.createdAt);
  const previousDate = new Date(previous.createdAt);
  const currentMs = currentDate.getTime();
  const previousMs = previousDate.getTime();
  if (!Number.isFinite(currentMs) || !Number.isFinite(previousMs)) return true;
  if (currentDate.toDateString() !== previousDate.toDateString()) return true;
  return currentMs - previousMs > GROUP_BREAK_MS;
}
