import { describe, it, expect } from 'vitest';
import {
  buildCalendarCacheErasurePlan,
  type CalendarCacheErasurePlan,
} from '../cache-erasure';

describe('buildCalendarCacheErasurePlan (#959 GDPR cache erasure, pure core)', () => {
  it('given a userId, should enumerate the erasure plan as pure data (no DB)', () => {
    const plan = buildCalendarCacheErasurePlan({ userId: 'user-abc' });

    expect(plan.userId).toBe('user-abc');
    expect(plan.deleteSyncedEvents).toBe(true);
    expect(plan.retainConnectionStub).toBe(true);
  });

  it('should scope synced-event deletion to this user AND syncedFromGoogle (excludes user-created events)', () => {
    const plan = buildCalendarCacheErasurePlan({ userId: 'user-abc' });

    expect(plan.syncedEventMatch).toEqual({
      createdById: 'user-abc',
      syncedFromGoogle: true,
    });
    // The marker that excludes user-CREATED events must be present and true.
    expect(plan.syncedEventMatch.syncedFromGoogle).toBe(true);
  });

  it('should NOT include user-created (non-Google-synced) events in the deletion plan', () => {
    const plan = buildCalendarCacheErasurePlan({ userId: 'user-abc' });

    // There is no field that would select syncedFromGoogle=false rows.
    expect(JSON.stringify(plan)).not.toContain('"syncedFromGoogle":false');
    // Erasure is gated on the syncedFromGoogle=true marker only.
    expect(plan.syncedEventMatch.syncedFromGoogle).toBe(true);
  });

  it('should list child tables in FK-safe deletion order (children before parent events)', () => {
    const plan = buildCalendarCacheErasurePlan({ userId: 'user-abc' });

    expect(plan.childDeletionOrder).toEqual([
      'calendar_triggers',
      'calendar_event_drives',
      'event_attendees',
    ]);
    // All listed children reference calendar_events and must precede it.
    expect(plan.childDeletionOrder).not.toContain('calendar_events');
  });

  it('should clear every connection cache/PII field', () => {
    const plan = buildCalendarCacheErasurePlan({ userId: 'user-abc' });

    expect(plan.clearConnectionCacheFields).toEqual([
      'syncCursor',
      'lastSyncAt',
      'lastSyncError',
      'webhookChannels',
      'selectedCalendars',
    ]);
  });

  it('should be referentially transparent (same input → deeply-equal output, no shared mutation)', () => {
    const a = buildCalendarCacheErasurePlan({ userId: 'user-xyz' });
    const b = buildCalendarCacheErasurePlan({ userId: 'user-xyz' });

    expect(a).toEqual(b);
    // Distinct object instances (no memoized shared reference leaking mutability).
    expect(a).not.toBe(b);

    // Mutating the first result must not affect a fresh call.
    (a as CalendarCacheErasurePlan).deleteSyncedEvents = false;
    const c = buildCalendarCacheErasurePlan({ userId: 'user-xyz' });
    expect(c.deleteSyncedEvents).toBe(true);
  });

  it('should reflect the userId verbatim for different users', () => {
    expect(buildCalendarCacheErasurePlan({ userId: 'u1' }).userId).toBe('u1');
    expect(buildCalendarCacheErasurePlan({ userId: 'u2' }).userId).toBe('u2');
  });
});
