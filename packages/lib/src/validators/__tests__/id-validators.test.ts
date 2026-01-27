import { describe, it, expect } from 'vitest'
import { createId } from '@paralleldrive/cuid2'
import {
  parseUserId,
  parsePageId,
  parseDriveId,
  parseId,
  IdValidationError,
  isValidId,
} from '../id-validators'

describe('ID validators', () => {
  const validCuid = createId()
  const anotherValidCuid = createId()

  describe('isValidId', () => {
    it('returns true for a valid CUID2', () => {
      expect(isValidId(validCuid)).toBe(true)
    })

    it('returns true for another valid CUID2', () => {
      expect(isValidId(anotherValidCuid)).toBe(true)
    })

    it('returns false for empty string', () => {
      expect(isValidId('')).toBe(false)
    })

    it('returns false for a plain string', () => {
      expect(isValidId('not-a-cuid')).toBe(false)
    })

    it('returns false for a UUID (wrong format for this project)', () => {
      expect(isValidId('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
    })

    it('returns false for single character', () => {
      expect(isValidId('a')).toBe(false)
    })
  })

  describe('parseId', () => {
    it('returns success with valid CUID2', () => {
      const result = parseId(validCuid, 'test')
      expect(result).toEqual({ success: true, data: validCuid })
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

    it('returns error for non-CUID2 format', () => {
      const result = parseId('not-a-valid-id', 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_ID_FORMAT')
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

    it('returns error for UUID format (not used in this project)', () => {
      const result = parseId('550e8400-e29b-41d4-a716-446655440000', 'testId')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_ID_FORMAT')
      }
    })
  })

  describe('parseUserId', () => {
    it('returns success with valid CUID2', () => {
      const result = parseUserId(validCuid)
      expect(result).toEqual({ success: true, data: validCuid })
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
    it('returns success with valid CUID2', () => {
      const result = parsePageId(validCuid)
      expect(result).toEqual({ success: true, data: validCuid })
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
    it('returns success with valid CUID2', () => {
      const result = parseDriveId(validCuid)
      expect(result).toEqual({ success: true, data: validCuid })
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
