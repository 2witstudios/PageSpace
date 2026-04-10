# Drive Calendar Filtering Epic

**Status**: ✅ COMPLETED (2026-04-10)
**Goal**: Google Calendar-style drive filtering for the root calendar

## Overview

Users viewing the root calendar (`/dashboard/calendar`) see events from all drives mixed together with no way to distinguish sources or filter by drive. This makes calendars with multiple active drives overwhelming and hard to scan. Adding a sidebar with toggleable, color-coded drive "sub-calendars" — matching the mental model of Google Calendar — lets users quickly see which drive an event belongs to and focus on the drives they care about right now.

---

## Drive Color Palette

Add a deterministic color palette and color resolution utilities to the existing calendar-types module.

**Requirements**:
- Given a set of accessible drives, should assign each drive a stable, visually distinct color from a fixed palette
- Given a personal event (driveId=null), should always assign a dedicated personal calendar color
- Given a calendar event in the root calendar (context='user'), should resolve to the drive's color instead of the per-event color
- Given a calendar event in a single-drive calendar (context='drive'), should continue using the per-event color as before

---

## Calendar Filter Store

Create a Zustand persist store that tracks which drive calendars are visible.

**Requirements**:
- Given a fresh session with no saved state, should default all calendars to visible
- Given a user toggling a drive off, should persist that choice to localStorage across page reloads
- Given a user clicking "show all" or "hide all", should toggle all calendars at once

---

## Calendar Sidebar Component

Build a sidebar listing each drive as a toggleable sub-calendar with its assigned color.

**Requirements**:
- Given the root calendar view, should display a "My Calendars" sidebar with "Personal" and one row per accessible drive
- Given each row, should show a colored checkbox and the calendar name
- Given a click on a checkbox, should toggle that calendar's visibility via the filter store

---

## CalendarView Integration

Wire the filter store, drive store, and color map into CalendarView to filter events and display the sidebar.

**Requirements**:
- Given context='user', should render the sidebar alongside the calendar content in a flex layout
- Given hidden calendars in the filter store, should exclude matching events and tasks before passing to views
- Given context='drive', should not render the sidebar or apply any filtering
- Given a sidebar toggle button in the header, should collapse/expand the sidebar on desktop

---

## View Color Resolution

Replace all getEventColors calls across view components with the new drive-aware color resolver.

**Requirements**:
- Given a view rendering events in context='user' with a driveColorMap, should color events by their drive source
- Given a view rendering events in context='drive' or without a driveColorMap, should fall back to per-event color
- Given all 7 view files (MonthView, WeekView, DayView, AgendaView, MobileCalendarView, MobileDayAgenda, MobileWeekStrip), should use the same resolveEventColor function

---

## Mobile Filter Sheet

Add a filter trigger to the mobile calendar that opens a bottom sheet with the same drive toggles.

**Requirements**:
- Given the mobile calendar view, should display a filter icon button in the header
- Given a tap on the filter button, should open a Sheet containing the CalendarSidebar component
- Given filter changes in the sheet, should immediately reflect in the mobile calendar view
