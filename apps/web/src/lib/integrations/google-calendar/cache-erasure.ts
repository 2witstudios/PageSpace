/**
 * Google Calendar Cache Erasure (pure core)
 *
 * GDPR Art 5(1)(e) storage limitation + Art 17 erasure (#959).
 *
 * When a user disconnects Google Calendar we must erase the cached PII that the
 * sync pipeline left behind. This module is the pure, deterministic decision
 * layer: given a userId it produces a DELETION PLAN describing exactly which
 * cached artifacts to hard-delete and which connection cache-fields to clear.
 *
 * It performs NO I/O. The disconnect route's imperative edge consumes this plan
 * to issue the actual Drizzle deletes in FK-safe order.
 *
 * Key invariant: only Google-SYNCED cached data is erasable. User-CREATED
 * calendar events (syncedFromGoogle = false) are NEVER part of the plan — they
 * are the user's own data, not cached third-party data, and survive disconnect.
 */

/** The fields that match cached, Google-synced events for a given user. */
export interface SyncedEventMatch {
  /** The owning user whose synced cache is being erased. */
  createdById: string;
  /** Marker column that distinguishes synced-from-Google cache from user-created events. */
  syncedFromGoogle: true;
}

/**
 * A fully-enumerated, DB-free description of the erasure to perform.
 * Child tables are listed in FK-safe deletion order (children before parents).
 */
export interface CalendarCacheErasurePlan {
  /** The user whose cached Google Calendar data is being erased. */
  userId: string;
  /** Whether to hard-delete the user's Google-synced cached events. Always true. */
  deleteSyncedEvents: boolean;
  /**
   * The predicate identifying which calendar_events rows are erasable cache.
   * Only rows owned by this user AND flagged syncedFromGoogle are included;
   * user-created events are excluded by construction.
   */
  syncedEventMatch: SyncedEventMatch;
  /**
   * Child/dependent tables to clear for the matched synced events, in the order
   * they must be deleted to satisfy FK constraints (children → parent last).
   * The matched calendar_events rows themselves are deleted last.
   */
  childDeletionOrder: ReadonlyArray<
    'calendar_triggers' | 'calendar_event_drives' | 'event_attendees'
  >;
  /** The cache/PII fields on the connection row to clear (set to null/empty). */
  clearConnectionCacheFields: ReadonlyArray<string>;
  /**
   * Whether to retain a minimal disconnected connection stub (status only) for
   * UX, rather than deleting the connection row entirely. We retain the stub but
   * strip every cache/PII field listed in clearConnectionCacheFields.
   */
  retainConnectionStub: boolean;
}

/** Input to the pure plan builder. */
export interface CalendarCacheErasureInput {
  /** The authenticated user disconnecting Google Calendar. */
  userId: string;
}

/**
 * Build the deletion plan for erasing a user's cached Google Calendar data.
 *
 * Referentially transparent: same input → deeply-equal output, no side effects.
 */
export function buildCalendarCacheErasurePlan(
  input: CalendarCacheErasureInput,
): CalendarCacheErasurePlan {
  return {
    userId: input.userId,
    deleteSyncedEvents: true,
    syncedEventMatch: {
      createdById: input.userId,
      syncedFromGoogle: true,
    },
    // FK-safe order: triggers + junction + attendees reference calendar_events,
    // so they must be removed before the events themselves.
    childDeletionOrder: ['calendar_triggers', 'calendar_event_drives', 'event_attendees'],
    clearConnectionCacheFields: [
      'syncCursor',
      'lastSyncAt',
      'lastSyncError',
      'webhookChannels',
      'selectedCalendars',
    ],
    retainConnectionStub: true,
  };
}
