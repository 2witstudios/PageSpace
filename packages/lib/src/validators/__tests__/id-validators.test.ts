import { describe, it, expect } from 'vitest'
import {
  parseUserId,
  parsePageId,
  parseDriveId,
  parseId,
  IdValidationError,
  isValidUuid,
} from '../id-validators'

describe('ID validators', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000'
  const anotherValidUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

  describe('isValidUuid', () => {
    it('returns true for valid lowercase UUID', () => {
      expect(isValidUuid(validUuid)).toBe(true)
    })

    it('returns true for valid uppercase UUID', () => {
      expect(isValidUuid(validUuid.toUpperCase())).toBe(true)
    })

    it('returns false for empty string', () => {
      expect(isValidUuid('')).toBe(false)
    })

    it('returns false for non-UUID string', () => {
      expect(isValidUuid('not-a-uuid')).toBe(false)
    })

    it('returns false for UUID without hyphens', () => {
      expect(isValidUuid('550e8400e29b41d4a716446655440000')).toBe(false)
    })

    it('returns false for UUID with wrong length', () => {
      expect(isValidUuid('550e8400-e29b-41d4-a716')).toBe(false)
    })

    it('returns false for string with invalid characters', () => {
      expect(isValidUuid('550e8400-e29b-41d4-a716-44665544000g')).toBe(false)
    })
  })

  describe('parseId', () => {
    it('returns success with valid UUID', () => {
      const result = parseId(validUuid, 'test')
      expect(result).toEqual({ success: true, data: validUuid.toLowerCase() })
    })

    it('normalizes UUID to lowercase', () => {
      const result = parseId(validUuid.toUpperCase(), 'test')
      expect(result).toEqual({ success: true, data: validUuid.toLowerCase() })
    })

    it('returns error for empty string', () => {
      const result = parseId('', 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBeInstanceOf(IdValidationError)
        expect(result.error.code).toBe('EMPTY_ID')
        expect(result.error.field).toBe('testId')
      }
    })

    it('returns error for non-string input', () => {
      const result = parseId(123 as unknown as string, 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_TYPE')
      }
    })

    it('returns error for null input', () => {
      const result = parseId(null as unknown as string, 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_TYPE')
      }
    })

    it('returns error for undefined input', () => {
      const result = parseId(undefined as unknown as string, 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_TYPE')
      }
    })

    it('returns error for non-UUID format', () => {
      const result = parseId('not-a-uuid', 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_UUID_FORMAT')
      }
    })

    it('returns error for excessively long string', () => {
      const longString = 'a'.repeat(1000)
      const result = parseId(longString, 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.code).toBe('ID_TOO_LONG')
      }
    })

    it('returns error for whitespace-only string', () => {
      const result = parseId('   ', 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.code).toBe('EMPTY_ID')
      }
    })

    it('trims whitespace from valid UUID', () => {
      const result = parseId(`  ${validUuid}  `, 'test')
      expect(result).toEqual({ success: true, data: validUuid.toLowerCase() })
    })
  })

  describe('parseUserId', () => {
    it('returns success with valid UUID', () => {
      const result = parseUserId(validUuid)
      expect(result).toEqual({ success: true, data: validUuid.toLowerCase() })
    })

    it('returns error with field name userId for invalid input', () => {
      const result = parseUserId('')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.field).toBe('userId')
      }
    })
  })

  describe('parsePageId', () => {
    it('returns success with valid UUID', () => {
      const result = parsePageId(validUuid)
      expect(result).toEqual({ success: true, data: validUuid.toLowerCase() })
    })

    it('returns error with field name pageId for invalid input', () => {
      const result = parsePageId('')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.field).toBe('pageId')
      }
    })
  })

  describe('parseDriveId', () => {
    it('returns success with valid UUID', () => {
      const result = parseDriveId(validUuid)
      expect(result).toEqual({ success: true, data: validUuid.toLowerCase() })
    })

    it('returns error with field name driveId for invalid input', () => {
      const result = parseDriveId('')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.field).toBe('driveId')
      }
    })
  })

  describe('IdValidationError', () => {
    it('has correct name property', () => {
      const error = new IdValidationError('test message', 'EMPTY_ID', 'testField')
      expect(error.name).toBe('IdValidationError')
    })

    it('has correct message property', () => {
      const error = new IdValidationError('test message', 'EMPTY_ID', 'testField')
      expect(error.message).toBe('test message')
    })

    it('has correct code property', () => {
      const error = new IdValidationError('test message', 'EMPTY_ID', 'testField')
      expect(error.code).toBe('EMPTY_ID')
    })

    it('has correct field property', () => {
      const error = new IdValidationError('test message', 'EMPTY_ID', 'testField')
      expect(error.field).toBe('testField')
    })
  })
})
