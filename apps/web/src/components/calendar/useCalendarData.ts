'use client';

import { useRef, useCallback, useMemo } from 'react';
import useSWR, { mutate } from 'swr';
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';
import { CalendarEvent, TaskWithDueDate } from './calendar-types';
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  subDays,
} from 'date-fns';

interface UseCalendarDataOptions {
  context: 'user' | 'drive';
  driveId?: string;
  currentDate: Date;
  includePersonal?: boolean;
  includeTasks?: boolean;
}

interface CalendarEventsResponse {
  events: CalendarEvent[];
}

interface CalendarTasksResponse {
  tasks: TaskWithDueDate[];
}

const fetcher = async (url: string) => {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error('Failed to fetch');
  return res.json();
};

export function useCalendarData({
  context,
  driveId,
  currentDate,
  includePersonal = true,
  includeTasks = true,
}: UseCalendarDataOptions) {
  const hasLoadedRef = useRef(false);
  const isAnyActive = useEditingStore((state) => state.isAnyActive());

  // Calculate date range for the current view (include buffer for multi-day events)
  const dateRange = useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    // Extend to include visible weeks
    const startDate = subDays(startOfWeek(monthStart), 7);
    const endDate = addDays(endOfWeek(monthEnd), 7);
    return { startDate, endDate };
  }, [currentDate]);

  // Build events query URL
  const eventsUrl = useMemo(() => {
    const params = new URLSearchParams({
      context,
      startDate: dateRange.startDate.toISOString(),
      endDate: dateRange.endDate.toISOString(),
      includePersonal: String(includePersonal),
    });
    if (driveId) {
      params.set('driveId', driveId);
    }
    return `/api/calendar/events?${params.toString()}`;
  }, [context, driveId, dateRange, includePersonal]);

  // Fetch events
  const {
    data: eventsData,
    error: eventsError,
    isLoading: eventsLoading,
  } = useSWR<CalendarEventsResponse>(eventsUrl, fetcher, {
    revalidateOnFocus: false,
    isPaused: () => hasLoadedRef.current && isAnyActive,
    onSuccess: () => {
      hasLoadedRef.current = true;
    },
    refreshInterval: 60000, // Refresh every minute
  });

  // Build tasks query URL (only fetch if includeTasks is true)
  const tasksUrl = useMemo(() => {
    if (!includeTasks) return null;
    const params = new URLSearchParams({
      context,
      startDate: dateRange.startDate.toISOString(),
      endDate: dateRange.endDate.toISOString(),
    });
    if (driveId) {
      params.set('driveId', driveId);
    }
    return `/api/tasks?${params.toString()}`;
  }, [context, driveId, dateRange, includeTasks]);

  // Fetch tasks with due dates
  const { data: tasksData } = useSWR<CalendarTasksResponse>(
    tasksUrl,
    tasksUrl ? fetcher : null,
    {
      revalidateOnFocus: false,
      isPaused: () => hasLoadedRef.current && isAnyActive,
      refreshInterval: 60000,
    }
  );

  // Create event - post() returns parsed JSON directly, throws on error
  const createEvent = useCallback(
    async (eventData: {
      title: string;
      description?: string;
      location?: string;
      startAt: Date;
      endAt: Date;
      allDay?: boolean;
      timezone?: string;
      visibility?: 'DRIVE' | 'ATTENDEES_ONLY' | 'PRIVATE';
      color?: string;
      attendeeIds?: string[];
      pageId?: string;
    }) => {
      const result = await post<CalendarEvent>('/api/calendar/events', {
        driveId: context === 'drive' ? driveId : null,
        ...eventData,
        startAt: eventData.startAt.toISOString(),
        endAt: eventData.endAt.toISOString(),
      });

      // Revalidate events
      mutate(eventsUrl);
      return result;
    },
    [context, driveId, eventsUrl]
  );

  // Update event - patch() returns parsed JSON directly, throws on error
  const updateEvent = useCallback(
    async (eventId: string, updates: Partial<Omit<CalendarEvent, 'startAt' | 'endAt'>> & { startAt?: Date | string; endAt?: Date | string }) => {
      const result = await patch<CalendarEvent>(`/api/calendar/events/${eventId}`, {
        ...updates,
        startAt: updates.startAt ? (updates.startAt instanceof Date ? updates.startAt.toISOString() : updates.startAt) : undefined,
        endAt: updates.endAt ? (updates.endAt instanceof Date ? updates.endAt.toISOString() : updates.endAt) : undefined,
      });

      // Revalidate events
      mutate(eventsUrl);
      return result;
    },
    [eventsUrl]
  );

  // Delete event - del() throws on error
  const deleteEvent = useCallback(
    async (eventId: string) => {
      await del(`/api/calendar/events/${eventId}`);

      // Revalidate events
      mutate(eventsUrl);
    },
    [eventsUrl]
  );

  // Update RSVP - patch() returns parsed JSON directly, throws on error
  const updateRsvp = useCallback(
    async (
      eventId: string,
      status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE',
      responseNote?: string
    ) => {
      const result = await patch<CalendarEvent>(`/api/calendar/events/${eventId}/attendees`, {
        status,
        responseNote,
      });

      // Revalidate events
      mutate(eventsUrl);
      return result;
    },
    [eventsUrl]
  );

  // Refresh data
  const refresh = useCallback(() => {
    mutate(eventsUrl);
    if (tasksUrl) {
      mutate(tasksUrl);
    }
  }, [eventsUrl, tasksUrl]);

  return {
    events: eventsData?.events ?? [],
    tasks: tasksData?.tasks ?? [],
    isLoading: eventsLoading,
    error: eventsError,
    createEvent,
    updateEvent,
    deleteEvent,
    updateRsvp,
    refresh,
  };
}
