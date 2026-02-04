# Google Calendar Sync Epic

**Status**: 📋 PLANNED
**Goal**: Enable users to optionally sync their Google Calendar with PageSpace without burdening users who don't want it.

## Overview

Users want their existing Google Calendar events visible in PageSpace so AI agents can help schedule around real commitments. Currently, PageSpace has a fully functional internal calendar with AI tools, but no connection to external calendars. This creates a gap where users must manually recreate events or constantly context-switch. This epic builds a lightweight Google Calendar integration that:

1. **Reuses existing Google OAuth** - just adds calendar scope (no new auth flow)
2. **Is completely opt-in** - zero UI changes for users who don't connect
3. **Surfaces naturally** - settings page + subtle calendar empty state hint
4. **Starts simple** - import-only first, two-way sync later
5. **Stores tokens separately** - dedicated table, not mixed with auth tokens

---

## UI Integration Points

### Settings Page Entry

Add to `/settings` in the "AI Integrations" section:

```
Google Calendar Sync
├── Icon: Calendar + Google colors
├── Description: "Import events from Google Calendar"
├── Status badge: "Not Connected" | "Connected" | "Syncing..."
└── href: /settings/integrations/google-calendar
```

### Settings Detail Page (`/settings/integrations/google-calendar`)

```
┌─────────────────────────────────────────────────────┐
│ Google Calendar                                      │
│ Import your Google Calendar events into PageSpace    │
├─────────────────────────────────────────────────────┤
│ [Not Connected]                                      │
│                                                      │
│ Benefits:                                            │
│ • AI can see your real availability                  │
│ • Schedule around existing commitments               │
│ • No manual event recreation                         │
│                                                      │
│ [Connect Google Calendar]  ← OAuth button            │
├─────────────────────────────────────────────────────┤
│ [Connected as user@gmail.com]              [Disconnect]
│                                                      │
│ Sync Settings:                                       │
│ ┌─ Import events to: [Default Drive ▼]              │
│ ├─ Calendars to sync: [✓] Primary [✓] Work [ ] Holidays
│ ├─ Sync frequency: [Every 15 minutes ▼]             │
│ └─ [✓] Mark imported events as read-only            │
│                                                      │
│ Last synced: 2 minutes ago                [Sync Now] │
└─────────────────────────────────────────────────────┘
```

### Calendar Empty State Enhancement

In `AgendaView.tsx` and other calendar views, enhance empty state:

```
┌─────────────────────────────────────────────────────┐
│           No events this month                       │
│     Click "New Event" to add one                    │
│                                                      │
│     ─────── or ───────                              │
│                                                      │
│     📅 Import from Google Calendar                   │
│         (subtle link, not a button)                  │
└─────────────────────────────────────────────────────┘
```

### Calendar Header Sync Indicator (Connected Users Only)

Small indicator in calendar header showing sync status:
- `🟢` Last synced 2m ago
- `🔄` Syncing...
- `⚠️` Sync error (click to retry)

---

## Database Schema

### Google Calendar Connections

```typescript
googleCalendarConnections = {
  id: string,                    // cuid
  userId: string,                // → users.id (unique per user)

  // OAuth tokens (encrypted at rest)
  accessToken: encrypted<string>,
  refreshToken: encrypted<string>,
  tokenExpiresAt: timestamp,

  // Google account info
  googleEmail: string,
  googleAccountId: string,

  // Sync configuration
  status: 'active' | 'expired' | 'error' | 'disconnected',
  statusMessage: string | null,

  targetDriveId: string,         // → drives.id (where to create events)
  selectedCalendars: string[],   // Google calendar IDs to sync
  syncFrequencyMinutes: number,  // 15, 30, 60
  markAsReadOnly: boolean,       // Prevent editing synced events

  // Sync state
  lastSyncAt: timestamp | null,
  lastSyncError: string | null,
  syncCursor: string | null,     // For incremental sync

  createdAt: timestamp,
  updatedAt: timestamp,
}
```

### Synced Events Tracking

```typescript
// Add to existing calendarEvents table
googleEventId: string | null,           // Google's event ID
googleCalendarId: string | null,        // Which Google calendar
syncedFromGoogle: boolean,              // true = imported, false = native
lastGoogleSync: timestamp | null,       // When last synced
```

---

## Settings Page Entry

Add Google Calendar to settings navigation.

**Requirements**:
- Given user visits `/settings`, should see "Google Calendar" in AI Integrations section with appropriate icon
- Given user has not connected Google Calendar, should show "Not Connected" badge
- Given user has connected Google Calendar, should show "Connected" badge with green indicator

---

## Google Calendar Settings Page

Create the detailed settings page for Google Calendar configuration.

**Requirements**:
- Given user is not connected, should show benefits and "Connect" button
- Given user clicks "Connect", should initiate OAuth flow with calendar scope
- Given user is connected, should show connected email and disconnect option
- Given user is connected, should show sync configuration options (drive, calendars, frequency)
- Given user clicks "Sync Now", should trigger immediate sync
- Given sync is in progress, should show loading state on button

---

## OAuth Scope Extension

Extend existing Google OAuth to request calendar scope.

**Requirements**:
- Given user initiates calendar connection, should request `calendar.readonly` scope in addition to existing scopes
- Given user has existing Google auth but no calendar scope, should prompt for incremental authorization
- Given user denies calendar permission, should show helpful error and allow retry
- Given user grants permission, should store tokens in `googleCalendarConnections` table (not auth table)

---

## Token Storage & Refresh

Implement secure token storage with automatic refresh.

**Requirements**:
- Given tokens are stored, should encrypt access and refresh tokens at rest
- Given access token is expired and refresh token is valid, should automatically refresh before API call
- Given refresh token is expired, should update connection status to 'expired' and prompt re-auth
- Given token refresh fails, should not break other PageSpace functionality

---

## Google Calendar API Client

Create pure functions for interacting with Google Calendar API.

**Requirements**:
- Given valid credentials, should list user's calendars
- Given calendar ID and date range, should fetch events
- Given API returns paginated results, should handle pagination transparently
- Given API rate limit is hit, should implement exponential backoff
- Given API returns error, should return structured error (not throw)

---

## Event Transformation

Create pure functions to transform between Google and PageSpace event formats.

**Requirements**:
- Given Google event with start/end times, should map to PageSpace `startsAt`/`endsAt`
- Given Google all-day event, should set `isAllDay: true` with appropriate times
- Given Google recurring event, should map recurrence rule to PageSpace format
- Given Google event with attendees, should create attendee records for known users
- Given Google event with location, should preserve in PageSpace location field
- Given Google event with HTML description, should sanitize to safe markdown

---

## Initial Sync Implementation

Implement first-time full sync from Google to PageSpace.

**Requirements**:
- Given user connects Google Calendar, should sync events from past 30 days to future 90 days
- Given sync finds new Google event, should create PageSpace event with `syncedFromGoogle: true`
- Given sync finds existing PageSpace event for Google event, should update if Google version is newer
- Given sync completes, should update `lastSyncAt` and `syncCursor`
- Given sync fails partway, should save progress and allow resume

---

## Incremental Sync Implementation

Implement periodic incremental sync using Google's sync tokens.

**Requirements**:
- Given `syncCursor` exists, should use Google's incremental sync API
- Given Google returns deleted event, should soft-delete corresponding PageSpace event
- Given Google returns updated event, should update PageSpace event if not locally modified
- Given conflict between local and Google changes, should prefer Google (for read-only mode)

---

## Background Sync Job

Implement background sync based on user-configured frequency.

**Requirements**:
- Given user has active connection with 15-minute frequency, should sync every 15 minutes
- Given user has multiple calendars selected, should sync all in single job
- Given sync job fails, should retry with backoff and update status to 'error' after 3 failures
- Given user is offline or token expired, should skip sync and log reason

---

## Calendar Empty State Enhancement

Add subtle Google Calendar suggestion to empty states.

**Requirements**:
- Given calendar view has no events, should show existing empty state message
- Given user has not connected Google Calendar, should show subtle "Import from Google Calendar" link below empty state
- Given user has connected Google Calendar, should not show the import suggestion
- Given user clicks import link, should navigate to `/settings/integrations/google-calendar`

---

## Sync Status Indicator

Add sync status to calendar header for connected users.

**Requirements**:
- Given user has connected Google Calendar, should show small sync indicator in calendar header
- Given sync completed recently, should show green dot with "Last synced X ago"
- Given sync is in progress, should show spinning indicator
- Given sync has error, should show warning icon with tooltip explaining issue
- Given user has not connected Google Calendar, should not show any indicator

---

## Disconnect Flow

Implement clean disconnection from Google Calendar.

**Requirements**:
- Given user clicks "Disconnect", should show confirmation dialog explaining data retention
- Given user confirms disconnect, should revoke Google OAuth token
- Given disconnect completes, should update connection status to 'disconnected'
- Given disconnect completes, should retain synced events but mark them as no longer syncing
- Given disconnect completes, should clear sensitive tokens from database

---

## AI Tool Integration

Expose sync status to AI calendar tools.

**Requirements**:
- Given AI calls `list_calendar_events`, should include both native and synced events
- Given AI calls `check_calendar_availability`, should consider synced events as busy time
- Given AI attempts to modify synced event with `markAsReadOnly: true`, should return helpful error
- Given user asks AI about calendar sync status, should provide accurate information

---

## Phase 2: Export to Google (Future)

Enable creating PageSpace events in Google Calendar.

**Requirements**:
- Given user enables two-way sync, should request `calendar` scope (not just readonly)
- Given user creates event in PageSpace, should optionally push to Google Calendar
- Given event is pushed to Google, should store `googleEventId` for future sync
- Given push fails, should queue for retry and notify user

---

## Phase 3: Two-Way Sync (Future)

Enable full bidirectional synchronization.

**Requirements**:
- Given event is modified in PageSpace, should push changes to Google
- Given event is modified in Google, should pull changes to PageSpace
- Given conflict exists, should use last-modified timestamp to resolve
- Given user requests, should allow manual conflict resolution
