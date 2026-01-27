/**
 * Per-Event Authorization Tests
 * Tests for re-checking permissions on sensitive real-time events
 *
 * Zero-trust principle: Don't trust room membership alone for writes.
 * Re-verify permission before allowing document updates, etc.
 */

import { describe, it, expect } from 'vitest';
import { shouldReauthorize, isSensitiveEvent, SensitiveEventType } from '../per-event-auth';

describe('Per-Event Authorization', () => {
  describe('isSensitiveEvent', () => {
    it('given document_update event, should be sensitive', () => {
      expect(isSensitiveEvent('document_update')).toBe(true);
    });

    it('given page_content_change event, should be sensitive', () => {
      expect(isSensitiveEvent('page_content_change')).toBe(true);
    });

    it('given cursor_move event, should NOT be sensitive (read-only)', () => {
      expect(isSensitiveEvent('cursor_move')).toBe(false);
    });

    it('given presence_update event, should NOT be sensitive (read-only)', () => {
      expect(isSensitiveEvent('presence_update')).toBe(false);
    });

    it('given typing_indicator event, should NOT be sensitive', () => {
      expect(isSensitiveEvent('typing_indicator')).toBe(false);
    });
  });

  describe('shouldReauthorize', () => {
    it('given sensitive event in page room, should require re-auth', () => {
      const result = shouldReauthorize({
        eventType: 'document_update',
        roomType: 'page',
        resourceId: 'page-123',
      });

      expect(result).toBe(true);
    });

    it('given non-sensitive event, should NOT require re-auth', () => {
      const result = shouldReauthorize({
        eventType: 'cursor_move',
        roomType: 'page',
        resourceId: 'page-123',
      });

      expect(result).toBe(false);
    });

    it('given activity room event, should NOT require re-auth (read-only room)', () => {
      const result = shouldReauthorize({
        eventType: 'activity_logged',
        roomType: 'activity',
        resourceId: 'drive-123',
      });

      expect(result).toBe(false);
    });

    it('given notification room event, should NOT require re-auth (user-specific room)', () => {
      const result = shouldReauthorize({
        eventType: 'document_update',
        roomType: 'notification',
        resourceId: 'user-123',
      });

      expect(result).toBe(false);
    });
  });
});

describe('SensitiveEventType', () => {
  it('should include all write operations', () => {
    const sensitiveEvents: SensitiveEventType[] = [
      'document_update',
      'page_content_change',
      'page_delete',
      'page_move',
      'file_upload',
      'comment_create',
      'comment_delete',
      'task_create',
      'task_update',
      'task_delete',
    ];

    sensitiveEvents.forEach(event => {
      expect(isSensitiveEvent(event)).toBe(true);
    });
  });
});
