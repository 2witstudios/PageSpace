"use client";

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Calendar, dateFnsLocalizer, View } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, addMonths, subMonths } from 'date-fns';
import { enUS } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { useAuth } from '@/hooks/use-auth';
import { fetchWithAuth } from '@/lib/auth-fetch';
import { toast } from 'sonner';
import { CalendarEvent, AggregatedEvent, CalendarEventsResponse } from '@pagespace/lib/calendar-types';
import { EventDialog } from './EventDialog';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useEditingStore } from '@/stores/useEditingStore';

// Setup the localizer for react-big-calendar
const locales = {
  'en-US': enUS,
};

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales,
});

interface CalendarViewProps {
  pageId: string;
}

interface CalendarEventWithDates extends AggregatedEvent {
  start: Date;
  end: Date;
}

export default function CalendarView({ pageId }: CalendarViewProps) {
  const { user } = useAuth();
  const [events, setEvents] = useState<CalendarEventWithDates[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('month');
  const [date, setDate] = useState(new Date());
  const [isEventDialogOpen, setIsEventDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventWithDates | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<{ start: Date; end: Date } | null>(null);

  // Register editing state while loading or saving
  useEffect(() => {
    const componentId = `calendar-${pageId}`;

    if (loading) {
      useEditingStore.getState().startEditing(componentId, 'calendar', {
        pageId: pageId,
        componentName: 'CalendarView',
      });
    } else {
      useEditingStore.getState().endEditing(componentId);
    }

    return () => {
      useEditingStore.getState().endEditing(componentId);
    };
  }, [loading, pageId]);

  // Fetch calendar events
  const fetchEvents = useCallback(async () => {
    if (!user) return;

    try {
      setLoading(true);
      const response = await fetchWithAuth(
        `/api/pages/${pageId}/calendar-events?includeAggregated=true`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch calendar events');
      }

      const data: CalendarEventsResponse = await response.json();

      // Convert ISO strings to Date objects for react-big-calendar
      const eventsWithDates: CalendarEventWithDates[] = data.flatEvents.map(event => ({
        ...event,
        start: new Date(event.start),
        end: new Date(event.end),
      }));

      setEvents(eventsWithDates);
    } catch (error) {
      console.error('Error fetching calendar events:', error);
      toast.error('Failed to load calendar events');
    } finally {
      setLoading(false);
    }
  }, [pageId, user]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Handle slot selection (creating new event)
  const handleSelectSlot = useCallback((slotInfo: { start: Date; end: Date }) => {
    setSelectedSlot(slotInfo);
    setSelectedEvent(null);
    setIsEventDialogOpen(true);
  }, []);

  // Handle event selection (editing existing event)
  const handleSelectEvent = useCallback((event: CalendarEventWithDates) => {
    // Only allow editing events from this calendar
    if (event.sourcePageId !== pageId) {
      toast.info('This event is from another calendar. Navigate to that calendar to edit it.');
      return;
    }
    setSelectedEvent(event);
    setSelectedSlot(null);
    setIsEventDialogOpen(true);
  }, [pageId]);

  // Handle event save
  const handleSaveEvent = async (eventData: Partial<CalendarEvent>) => {
    try {
      if (selectedEvent) {
        // Update existing event
        const response = await fetchWithAuth(
          `/api/pages/${pageId}/events/${selectedEvent.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(eventData),
          }
        );

        if (!response.ok) {
          throw new Error('Failed to update event');
        }

        toast.success('Event updated');
      } else {
        // Create new event
        const response = await fetchWithAuth(
          `/api/pages/${pageId}/events`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(eventData),
          }
        );

        if (!response.ok) {
          throw new Error('Failed to create event');
        }

        toast.success('Event created');
      }

      // Refresh events
      await fetchEvents();
      setIsEventDialogOpen(false);
      setSelectedEvent(null);
      setSelectedSlot(null);
    } catch (error) {
      console.error('Error saving event:', error);
      toast.error('Failed to save event');
    }
  };

  // Handle event delete
  const handleDeleteEvent = async () => {
    if (!selectedEvent) return;

    try {
      const response = await fetchWithAuth(
        `/api/pages/${pageId}/events/${selectedEvent.id}`,
        {
          method: 'DELETE',
        }
      );

      if (!response.ok) {
        throw new Error('Failed to delete event');
      }

      toast.success('Event deleted');
      await fetchEvents();
      setIsEventDialogOpen(false);
      setSelectedEvent(null);
    } catch (error) {
      console.error('Error deleting event:', error);
      toast.error('Failed to delete event');
    }
  };

  // Custom event style getter (color events by source)
  const eventStyleGetter = useCallback((event: CalendarEventWithDates) => {
    const style: React.CSSProperties = {
      backgroundColor: event.color || '#3174ad',
      borderRadius: '4px',
      opacity: event.sourcePageId === pageId ? 1 : 0.75,
      color: 'white',
      border: '0px',
      display: 'block',
    };
    return { style };
  }, [pageId]);

  // Navigation handlers
  const handleNavigate = useCallback((newDate: Date) => {
    setDate(newDate);
  }, []);

  const handleViewChange = useCallback((newView: View) => {
    setView(newView);
  }, []);

  const handlePrevious = useCallback(() => {
    setDate(prev => {
      switch (view) {
        case 'month':
          return subMonths(prev, 1);
        case 'week':
          return new Date(prev.getTime() - 7 * 24 * 60 * 60 * 1000);
        case 'day':
          return new Date(prev.getTime() - 24 * 60 * 60 * 1000);
        default:
          return prev;
      }
    });
  }, [view]);

  const handleNext = useCallback(() => {
    setDate(prev => {
      switch (view) {
        case 'month':
          return addMonths(prev, 1);
        case 'week':
          return new Date(prev.getTime() + 7 * 24 * 60 * 60 * 1000);
        case 'day':
          return new Date(prev.getTime() + 24 * 60 * 60 * 1000);
        default:
          return prev;
      }
    });
  }, [view]);

  const handleToday = useCallback(() => {
    setDate(new Date());
  }, []);

  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading calendar...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Calendar toolbar */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handlePrevious}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleToday}>
            Today
          </Button>
          <Button variant="outline" size="sm" onClick={handleNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-4 text-lg font-semibold">
            {format(date, 'MMMM yyyy')}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <Button
              variant={view === 'month' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleViewChange('month')}
            >
              Month
            </Button>
            <Button
              variant={view === 'week' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleViewChange('week')}
            >
              Week
            </Button>
            <Button
              variant={view === 'day' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleViewChange('day')}
            >
              Day
            </Button>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setSelectedSlot({ start: new Date(), end: new Date() });
              setSelectedEvent(null);
              setIsEventDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-1" />
            New Event
          </Button>
        </div>
      </div>

      {/* Calendar component */}
      <div className="flex-1 p-4 overflow-auto">
        <Calendar
          localizer={localizer}
          events={events}
          startAccessor="start"
          endAccessor="end"
          titleAccessor="title"
          view={view}
          onView={handleViewChange}
          date={date}
          onNavigate={handleNavigate}
          onSelectSlot={handleSelectSlot}
          onSelectEvent={handleSelectEvent}
          eventPropGetter={eventStyleGetter}
          selectable
          popup
          style={{ height: '100%', minHeight: '500px' }}
          toolbar={false} // We're using custom toolbar
        />
      </div>

      {/* Event dialog */}
      {isEventDialogOpen && (
        <EventDialog
          open={isEventDialogOpen}
          onClose={() => {
            setIsEventDialogOpen(false);
            setSelectedEvent(null);
            setSelectedSlot(null);
          }}
          onSave={handleSaveEvent}
          onDelete={selectedEvent ? handleDeleteEvent : undefined}
          event={selectedEvent}
          initialStart={selectedSlot?.start}
          initialEnd={selectedSlot?.end}
        />
      )}
    </div>
  );
}
