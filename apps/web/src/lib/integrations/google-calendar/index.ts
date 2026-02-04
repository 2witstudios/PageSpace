export {
  getValidAccessToken,
  getConnectionStatus,
  updateConnectionStatus,
  isTokenExpired,
  type TokenRefreshResult,
} from './token-refresh';

export {
  listCalendars,
  listEvents,
  getEvent,
  buildAuthHeader,
  buildCalendarListUrl,
  buildEventsListUrl,
  type GoogleCalendar,
  type GoogleCalendarEvent,
  type GoogleEventDateTime,
  type GoogleEventAttendee,
  type GoogleApiResult,
} from './api-client';

export {
  transformGoogleEventToPageSpace,
  parseGoogleDateTime,
  parseRecurrenceRule,
  sanitizeDescription,
  mapGoogleColor,
  mapGoogleVisibility,
  shouldSyncEvent,
  needsUpdate,
} from './event-transform';
