# Review Vector: Schedule Calendar Event

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/calendar/events/route.ts`, `apps/web/src/app/api/calendar/events/[eventId]/route.ts`, `apps/web/src/app/api/calendar/events/[eventId]/attendees/route.ts`, `apps/web/src/components/calendar/CalendarView.tsx`, `apps/web/src/components/calendar/EventModal.tsx`, `apps/web/src/components/calendar/WeekView.tsx`, `apps/web/src/components/calendar/DayView.tsx`, `apps/web/src/components/calendar/MonthView.tsx`, `apps/web/src/components/calendar/useCalendarData.ts`, `apps/web/src/lib/websocket/calendar-events.ts`, `packages/db/src/schema/calendar.ts`
**Level**: domain

## Context
The calendar journey begins when a user clicks a time slot in the calendar view, opening the EventModal to enter event details. Submitting creates the event via the calendar events API, which inserts the record in the database and optionally syncs to Google Calendar via the integrations layer. The useCalendarData hook refetches to display the new event, and real-time calendar WebSocket events notify other connected users of the change. This flow crosses the calendar UI components with multiple view modes, API route handlers, database persistence, optional third-party Google Calendar integration, and real-time event broadcasting.
