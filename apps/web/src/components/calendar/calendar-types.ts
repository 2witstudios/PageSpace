/**
 * Calendar component types and configurations
 */

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda';

export type EventVisibility = 'DRIVE' | 'ATTENDEES_ONLY' | 'PRIVATE';
export type AttendeeStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';

export interface CalendarEventAttendee {
  id: string;
  eventId: string;
  userId: string;
  status: AttendeeStatus;
  responseNote: string | null;
  isOrganizer: boolean;
  isOptional: boolean;
  invitedAt: string;
  respondedAt: string | null;
  user: {
    id: string;
    name: string | null;
    image: string | null;
  };
}

export interface CalendarEvent {
  id: string;
  driveId: string | null;
  createdById: string;
  pageId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  recurrenceRule: RecurrenceRule | null;
  visibility: EventVisibility;
  color: string;
  syncedFromGoogle: boolean;
  googleSyncReadOnly: boolean | null;
  createdAt: string;
  updatedAt: string;
  createdBy: {
    id: string;
    name: string | null;
    image: string | null;
  };
  attendees: CalendarEventAttendee[];
  page?: {
    id: string;
    title: string;
    type: string;
  } | null;
  drive?: {
    id: string;
    name: string;
    slug: string;
  } | null;
  hasAgentTrigger?: boolean;
}

export interface RecurrenceRule {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay?: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[];
  byMonthDay?: number[];
  byMonth?: number[];
  count?: number;
  until?: string;
}

export interface TaskWithDueDate {
  id: string;
  title: string;
  dueDate: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: 'low' | 'medium' | 'high';
  taskListPageId: string;
  driveId: string;
}

// Color config shape shared by event colors and drive calendar colors
export type EventColorConfig = {
  bg: string;
  border: string;
  text: string;
  dot: string;
};

// Drive calendar color palette — visually distinct colors for sub-calendars
export const DRIVE_CALENDAR_COLORS: EventColorConfig[] = [
  { bg: 'bg-blue-500/10', border: 'border-l-blue-500', text: 'text-blue-600', dot: 'bg-blue-500' },
  { bg: 'bg-emerald-500/10', border: 'border-l-emerald-500', text: 'text-emerald-600', dot: 'bg-emerald-500' },
  { bg: 'bg-violet-500/10', border: 'border-l-violet-500', text: 'text-violet-600', dot: 'bg-violet-500' },
  { bg: 'bg-amber-500/10', border: 'border-l-amber-500', text: 'text-amber-600', dot: 'bg-amber-500' },
  { bg: 'bg-rose-500/10', border: 'border-l-rose-500', text: 'text-rose-600', dot: 'bg-rose-500' },
  { bg: 'bg-cyan-500/10', border: 'border-l-cyan-500', text: 'text-cyan-600', dot: 'bg-cyan-500' },
  { bg: 'bg-orange-500/10', border: 'border-l-orange-500', text: 'text-orange-600', dot: 'bg-orange-500' },
  { bg: 'bg-pink-500/10', border: 'border-l-pink-500', text: 'text-pink-600', dot: 'bg-pink-500' },
  { bg: 'bg-teal-500/10', border: 'border-l-teal-500', text: 'text-teal-600', dot: 'bg-teal-500' },
  { bg: 'bg-indigo-500/10', border: 'border-l-indigo-500', text: 'text-indigo-600', dot: 'bg-indigo-500' },
];

// Dedicated color for personal (non-drive) events
export const PERSONAL_CALENDAR_COLOR: EventColorConfig = {
  bg: 'bg-slate-500/10',
  border: 'border-l-slate-500',
  text: 'text-slate-600',
  dot: 'bg-slate-500',
};

// Deterministic drive-to-color assignment
export function getDriveCalendarColor(
  driveId: string | null,
  driveIds: string[]
): EventColorConfig {
  if (driveId === null) return PERSONAL_CALENDAR_COLOR;
  const sorted = [...driveIds].sort();
  const index = sorted.indexOf(driveId);
  if (index < 0) return DRIVE_CALENDAR_COLORS[0];
  return DRIVE_CALENDAR_COLORS[index % DRIVE_CALENDAR_COLORS.length];
}

// Resolve an event's display color based on context
export function resolveEventColor(
  event: CalendarEvent,
  context: 'user' | 'drive',
  driveColorMap: Map<string | null, EventColorConfig> | null
): EventColorConfig {
  if (context === 'drive' || !driveColorMap) {
    return getEventColors(event.color);
  }
  return driveColorMap.get(event.driveId) ?? getEventColors(event.color);
}

// Event color configurations
export const EVENT_COLORS = {
  default: {
    bg: 'bg-primary/10',
    border: 'border-l-primary',
    text: 'text-primary',
    dot: 'bg-primary',
  },
  meeting: {
    bg: 'bg-purple-500/10',
    border: 'border-l-purple-500',
    text: 'text-purple-600',
    dot: 'bg-purple-500',
  },
  deadline: {
    bg: 'bg-red-500/10',
    border: 'border-l-red-500',
    text: 'text-red-600',
    dot: 'bg-red-500',
  },
  personal: {
    bg: 'bg-green-500/10',
    border: 'border-l-green-500',
    text: 'text-green-600',
    dot: 'bg-green-500',
  },
  travel: {
    bg: 'bg-amber-500/10',
    border: 'border-l-amber-500',
    text: 'text-amber-600',
    dot: 'bg-amber-500',
  },
  focus: {
    bg: 'bg-slate-500/10',
    border: 'border-l-slate-500',
    text: 'text-slate-600',
    dot: 'bg-slate-500',
  },
} as const;

// Task overlay styling (muted compared to events)
export const TASK_OVERLAY_STYLE = {
  bg: 'bg-muted/30',
  border: 'border-l-muted-foreground/50 border-dashed',
  text: 'text-muted-foreground italic',
  opacity: 'opacity-70',
};

// Attendee status configurations
export const ATTENDEE_STATUS_CONFIG = {
  PENDING: { label: 'Pending', color: 'bg-muted text-muted-foreground' },
  ACCEPTED: { label: 'Accepted', color: 'bg-green-100 text-green-700' },
  DECLINED: { label: 'Declined', color: 'bg-red-100 text-red-700' },
  TENTATIVE: { label: 'Maybe', color: 'bg-amber-100 text-amber-700' },
} as const;

// Calendar view handlers
export interface CalendarHandlers {
  onEventClick: (event: CalendarEvent) => void;
  onEventCreate: (start: Date, end: Date, allDay?: boolean) => void;
  onEventUpdate: (eventId: string, updates: Partial<CalendarEvent>) => void;
  onEventDelete: (eventId: string) => void;
  onTaskClick?: (task: TaskWithDueDate) => void;
  onDateChange: (date: Date) => void;
  onViewChange: (view: CalendarViewMode) => void;
}

// Helper to get event colors
export function getEventColors(color: string) {
  return EVENT_COLORS[color as keyof typeof EVENT_COLORS] ?? EVENT_COLORS.default;
}

// Helper to check if date is today
export function isToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}

// Helper to check if two dates are the same day
export function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getDate() === date2.getDate() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getFullYear() === date2.getFullYear()
  );
}

// Helper to get events for a specific day
export function getEventsForDay(events: CalendarEvent[], date: Date): CalendarEvent[] {
  return events.filter((event) => {
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    // Event overlaps with this day
    return start <= dayEnd && end >= dayStart;
  });
}

// Helper to get tasks for a specific day
export function getTasksForDay(tasks: TaskWithDueDate[], date: Date): TaskWithDueDate[] {
  return tasks.filter((task) => {
    const dueDate = new Date(task.dueDate);
    return isSameDay(dueDate, date);
  });
}

// Format time for display
export function formatEventTime(date: Date, allDay: boolean): string {
  if (allDay) return 'All day';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Get hour from date (0-23)
export function getHour(date: Date): number {
  return date.getHours();
}

// Get minutes from date (0-59)
export function getMinutes(date: Date): number {
  return date.getMinutes();
}
