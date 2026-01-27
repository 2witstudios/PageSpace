/**
 * WebSocket Payload Validation Tests
 * TDD-first: Pure functions for validating socket event payloads
 *
 * Following Eric Elliott's approach:
 * - Pure predicates (isUUID, isNotTooLong)
 * - Composed validators (validatePageId, validateDriveId, etc.)
 * - Result types instead of exceptions
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isUUID,
  isNotTooLong,
  validatePageId,
  validateDriveId,
  validateConversationId,
  emitValidationError,
  type ValidationResult,
} from '../validation';

describe('isUUID', () => {
  describe('given valid UUID v4 strings', () => {
    it('should return true for lowercase UUID', () => {
      const result = isUUID('550e8400-e29b-41d4-a716-446655440000');
      expect(result).toBe(true);
    });

    it('should return true for uppercase UUID', () => {
      const result = isUUID('550E8400-E29B-41D4-A716-446655440000');
      expect(result).toBe(true);
    });

    it('should return true for mixed case UUID', () => {
      const result = isUUID('550e8400-E29B-41d4-A716-446655440000');
      expect(result).toBe(true);
    });
  });

  describe('given invalid inputs', () => {
    it('should return false for non-string input (number)', () => {
      const result = isUUID(12345);
      expect(result).toBe(false);
    });

    it('should return false for non-string input (null)', () => {
      const result = isUUID(null);
      expect(result).toBe(false);
    });

    it('should return false for non-string input (undefined)', () => {
      const result = isUUID(undefined);
      expect(result).toBe(false);
    });

    it('should return false for non-string input (object)', () => {
      const result = isUUID({ id: '550e8400-e29b-41d4-a716-446655440000' });
      expect(result).toBe(false);
    });

    it('should return false for non-string input (array)', () => {
      const result = isUUID(['550e8400-e29b-41d4-a716-446655440000']);
      expect(result).toBe(false);
    });

    it('should return false for empty string', () => {
      const result = isUUID('');
      expect(result).toBe(false);
    });

    it('should return false for UUID without hyphens', () => {
      const result = isUUID('550e8400e29b41d4a716446655440000');
      expect(result).toBe(false);
    });

    it('should return false for UUID with wrong hyphen positions', () => {
      const result = isUUID('550e84-00e29b-41d4a-716446-655440000');
      expect(result).toBe(false);
    });

    it('should return false for too short string', () => {
      const result = isUUID('550e8400-e29b-41d4');
      expect(result).toBe(false);
    });

    it('should return false for too long string', () => {
      const result = isUUID('550e8400-e29b-41d4-a716-446655440000-extra');
      expect(result).toBe(false);
    });

    it('should return false for string with invalid characters', () => {
      const result = isUUID('550e8400-e29b-41d4-a716-44665544000g');
      expect(result).toBe(false);
    });

    it('should return false for SQL injection attempt', () => {
      const result = isUUID("'; DROP TABLE pages; --");
      expect(result).toBe(false);
    });

    it('should return false for extremely long string (DoS prevention)', () => {
      const longString = 'a'.repeat(10000);
      const result = isUUID(longString);
      expect(result).toBe(false);
    });
  });
});

describe('isNotTooLong', () => {
  describe('given max length of 36 (UUID length)', () => {
    const checkLength = isNotTooLong(36);

    it('should return true for string at max length', () => {
      const result = checkLength('550e8400-e29b-41d4-a716-446655440000');
      expect(result).toBe(true);
    });

    it('should return true for string under max length', () => {
      const result = checkLength('short');
      expect(result).toBe(true);
    });

    it('should return false for string over max length', () => {
      const result = checkLength('550e8400-e29b-41d4-a716-446655440000-extra');
      expect(result).toBe(false);
    });

    it('should return true for empty string', () => {
      const result = checkLength('');
      expect(result).toBe(true);
    });
  });
});

describe('validatePageId', () => {
  describe('given valid page ID', () => {
    it('should return success with the validated UUID', () => {
      const result = validatePageId('550e8400-e29b-41d4-a716-446655440000');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('550e8400-e29b-41d4-a716-446655440000');
      }
    });
  });

  describe('given invalid page ID', () => {
    it('should return failure for non-UUID string', () => {
      const result = validatePageId('not-a-uuid');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('invalid');
      }
    });

    it('should return failure for non-string input', () => {
      const result = validatePageId(12345);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('string');
      }
    });

    it('should return failure for null', () => {
      const result = validatePageId(null);

      expect(result.ok).toBe(false);
    });

    it('should return failure for undefined', () => {
      const result = validatePageId(undefined);

      expect(result.ok).toBe(false);
    });
  });
});

describe('validateDriveId', () => {
  describe('given valid drive ID', () => {
    it('should return success with the validated UUID', () => {
      const result = validateDriveId('660e8400-e29b-41d4-a716-446655440000');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('660e8400-e29b-41d4-a716-446655440000');
      }
    });
  });

  describe('given invalid drive ID', () => {
    it('should return failure for SQL injection attempt', () => {
      const result = validateDriveId("' OR '1'='1");

      expect(result.ok).toBe(false);
    });

    it('should return failure for extremely long string', () => {
      const result = validateDriveId('a'.repeat(1000));

      expect(result.ok).toBe(false);
    });
  });
});

describe('validateConversationId', () => {
  describe('given valid conversation ID', () => {
    it('should return success with the validated UUID', () => {
      const result = validateConversationId('770e8400-e29b-41d4-a716-446655440000');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('770e8400-e29b-41d4-a716-446655440000');
      }
    });
  });

  describe('given invalid conversation ID', () => {
    it('should return failure for object payload', () => {
      const result = validateConversationId({ conversationId: '770e8400-e29b-41d4-a716-446655440000' });

      expect(result.ok).toBe(false);
    });

    it('should return failure for array payload', () => {
      const result = validateConversationId(['770e8400-e29b-41d4-a716-446655440000']);

      expect(result.ok).toBe(false);
    });
  });
});

describe('emitValidationError', () => {
  it('should emit error event with validation details', () => {
    const mockSocket = {
      emit: vi.fn(),
    };

    emitValidationError(mockSocket, 'join_channel', 'invalid Page ID format');

    expect(mockSocket.emit).toHaveBeenCalledWith('validation_error', {
      event: 'join_channel',
      error: 'invalid Page ID format',
    });
  });
});

/**
 * Integration tests for payload rejection scenarios
 * These tests verify that invalid payloads are rejected before any DB query
 */
describe('Integration: Invalid Payload Rejection', () => {
  describe('given malicious payloads', () => {
    it('should reject SQL injection in page ID', () => {
      const result = validatePageId("'; DROP TABLE pages; --");
      expect(result.ok).toBe(false);
    });

    it('should reject SQL injection in drive ID', () => {
      const result = validateDriveId("' OR '1'='1' --");
      expect(result.ok).toBe(false);
    });

    it('should reject SQL injection in conversation ID', () => {
      const result = validateConversationId("1; DELETE FROM dm_conversations;");
      expect(result.ok).toBe(false);
    });

    it('should reject path traversal attempts', () => {
      const result = validatePageId('../../../etc/passwd');
      expect(result.ok).toBe(false);
    });
  });

  describe('given DoS attempt payloads', () => {
    it('should reject extremely long page ID (10KB)', () => {
      const longPayload = 'a'.repeat(10240);
      const result = validatePageId(longPayload);
      expect(result.ok).toBe(false);
    });

    it('should reject extremely long drive ID (1MB)', () => {
      const longPayload = 'b'.repeat(1024 * 1024);
      const result = validateDriveId(longPayload);
      expect(result.ok).toBe(false);
    });

    it('should reject nested object payloads', () => {
      const nestedPayload = { id: { nested: { deep: { id: 'test' } } } };
      const result = validatePageId(nestedPayload);
      expect(result.ok).toBe(false);
    });

    it('should reject array payloads', () => {
      const arrayPayload = ['550e8400-e29b-41d4-a716-446655440000', '550e8400-e29b-41d4-a716-446655440001'];
      const result = validateDriveId(arrayPayload);
      expect(result.ok).toBe(false);
    });
  });

  describe('given type coercion attack payloads', () => {
    it('should reject number that looks like valid data', () => {
      const result = validatePageId(12345678901234567890n);
      expect(result.ok).toBe(false);
    });

    it('should reject boolean true', () => {
      const result = validateDriveId(true);
      expect(result.ok).toBe(false);
    });

    it('should reject boolean false', () => {
      const result = validateConversationId(false);
      expect(result.ok).toBe(false);
    });

    it('should reject object with toString that returns valid UUID', () => {
      const payload = {
        toString: () => '550e8400-e29b-41d4-a716-446655440000',
      };
      const result = validatePageId(payload);
      expect(result.ok).toBe(false);
    });
  });

  describe('given edge case payloads', () => {
    it('should reject empty string', () => {
      const result = validatePageId('');
      expect(result.ok).toBe(false);
    });

    it('should reject whitespace-only string', () => {
      const result = validateDriveId('   ');
      expect(result.ok).toBe(false);
    });

    it('should reject UUID with leading whitespace', () => {
      const result = validateConversationId(' 550e8400-e29b-41d4-a716-446655440000');
      expect(result.ok).toBe(false);
    });

    it('should reject UUID with trailing whitespace', () => {
      const result = validatePageId('550e8400-e29b-41d4-a716-446655440000 ');
      expect(result.ok).toBe(false);
    });

    it('should reject UUID with newline', () => {
      const result = validateDriveId('550e8400-e29b-41d4-a716-446655440000\n');
      expect(result.ok).toBe(false);
    });

    it('should reject null byte injection', () => {
      const result = validateConversationId('550e8400-e29b-41d4-a716-446655440000\x00malicious');
      expect(result.ok).toBe(false);
    });
  });
});
