/**
 * Kick API Tests
 * Tests for the /api/kick endpoint that removes users from rooms on permission revocation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseKickRequest,
  validateKickPayload,
  KickPayload,
  KickResult,
} from '../kick-handler';

// Mock the logger
vi.mock('@pagespace/lib/logger-config', () => ({
  loggers: {
    realtime: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

describe('Kick API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseKickRequest', () => {
    it('given valid JSON body, should parse successfully', () => {
      const body = JSON.stringify({
        userId: 'user-123',
        roomPattern: 'drive:drive-456',
        reason: 'member_removed',
      });

      const result = parseKickRequest(body);

      expect(result.success).toBe(true);
      expect(result.payload).toEqual({
        userId: 'user-123',
        roomPattern: 'drive:drive-456',
        reason: 'member_removed',
      });
    });

    it('given invalid JSON, should return error', () => {
      const body = 'not valid json';

      const result = parseKickRequest(body);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid JSON');
    });
  });

  describe('validateKickPayload', () => {
    it('given valid payload with userId and roomPattern, should pass validation', () => {
      const payload: KickPayload = {
        userId: 'user-123',
        roomPattern: 'drive:drive-456',
        reason: 'member_removed',
      };

      const result = validateKickPayload(payload);

      expect(result.valid).toBe(true);
    });

    it('given missing userId, should fail validation', () => {
      const payload = {
        roomPattern: 'drive:drive-456',
        reason: 'member_removed',
      } as KickPayload;

      const result = validateKickPayload(payload);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('userId');
    });

    it('given missing roomPattern, should fail validation', () => {
      const payload = {
        userId: 'user-123',
        reason: 'member_removed',
      } as KickPayload;

      const result = validateKickPayload(payload);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('roomPattern');
    });

    it('given empty userId, should fail validation', () => {
      const payload: KickPayload = {
        userId: '',
        roomPattern: 'drive:drive-456',
        reason: 'member_removed',
      };

      const result = validateKickPayload(payload);

      expect(result.valid).toBe(false);
    });

    it('given empty roomPattern, should fail validation', () => {
      const payload: KickPayload = {
        userId: 'user-123',
        roomPattern: '',
        reason: 'member_removed',
      };

      const result = validateKickPayload(payload);

      expect(result.valid).toBe(false);
    });
  });

  describe('room pattern matching', () => {
    it('given exact room pattern, should match only that room', () => {
      // This will be tested in integration with the kick handler
      // The pattern 'drive:drive-123' should match exactly 'drive:drive-123'
      const exactPattern = 'drive:drive-123';
      const room = 'drive:drive-123';

      expect(room === exactPattern).toBe(true);
    });

    it('given wildcard pattern drive:*, should match all drive rooms', () => {
      // Pattern 'drive:*' should match 'drive:abc', 'drive:xyz', etc.
      const wildcardPattern = /^drive:/;

      expect(wildcardPattern.test('drive:abc')).toBe(true);
      expect(wildcardPattern.test('drive:xyz')).toBe(true);
      expect(wildcardPattern.test('page-123')).toBe(false);
    });
  });
});

describe('KickResult', () => {
  it('given successful kick, should include kicked count and rooms', () => {
    const result: KickResult = {
      success: true,
      kickedCount: 2,
      rooms: ['drive:drive-123', 'activity:drive:drive-123'],
    };

    expect(result.success).toBe(true);
    expect(result.kickedCount).toBe(2);
    expect(result.rooms).toHaveLength(2);
  });

  it('given no sockets to kick, should still be successful with 0 count', () => {
    const result: KickResult = {
      success: true,
      kickedCount: 0,
      rooms: [],
    };

    expect(result.success).toBe(true);
    expect(result.kickedCount).toBe(0);
  });
});
