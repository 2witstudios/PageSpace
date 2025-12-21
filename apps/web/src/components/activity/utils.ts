import { isToday, isYesterday, isThisWeek, format } from 'date-fns';
import type { ActivityLog } from './types';

export function getInitials(name: string | null, email: string): string {
  if (name) {
    return name
      .split(' ')
      .filter((n) => n.length > 0)
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return email.slice(0, 2).toUpperCase();
}

export function groupActivitiesByDate(activities: ActivityLog[]): Map<string, ActivityLog[]> {
  const groups = new Map<string, ActivityLog[]>();

  activities.forEach((activity) => {
    const date = new Date(activity.timestamp);
    let groupKey: string;

    if (isToday(date)) {
      groupKey = 'Today';
    } else if (isYesterday(date)) {
      groupKey = 'Yesterday';
    } else if (isThisWeek(date)) {
      groupKey = format(date, 'EEEE'); // Day name
    } else {
      groupKey = format(date, 'MMMM d, yyyy');
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(activity);
  });

  return groups;
}

export function formatDateRange(startDate?: Date, endDate?: Date): string {
  if (!startDate && !endDate) {
    return 'All time';
  }
  if (startDate && endDate) {
    return `${format(startDate, 'MMM d')} - ${format(endDate, 'MMM d, yyyy')}`;
  }
  if (startDate) {
    return `From ${format(startDate, 'MMM d, yyyy')}`;
  }
  if (endDate) {
    return `Until ${format(endDate, 'MMM d, yyyy')}`;
  }
  return 'All time';
}
