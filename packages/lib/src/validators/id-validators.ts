import { z } from 'zod'

/**
 * Maximum length for ID strings before UUID validation.
 * UUIDs are 36 characters. Allow some buffer but reject absurdly long strings early.
 */
const MAX_ID_LENGTH = 100

/**
 * UUID regex pattern (case-insensitive)
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Error codes for ID validation failures
 */
export type IdValidationErrorCode =
  | 'INVALID_TYPE'
  | 'EMPTY_ID'
  | 'ID_TOO_LONG'
  | 'INVALID_UUID_FORMAT'

/**
 * Custom error class for ID validation failures.
 * Provides structured error information for debugging and error handling.
 */
export class IdValidationError extends Error {
  readonly name = 'IdValidationError' as const
  readonly code: IdValidationErrorCode
  readonly field: string

  constructor(message: string, code: IdValidationErrorCode, field: string) {
    super(message)
    this.code = code
    this.field = field
  }
}

/**
 * Result type for ID parsing operations.
 * Provides type-safe error handling without exceptions.
 */
export type IdParseResult =
  | { success: true; data: string }
  | { success: false; error: IdValidationError }

/**
 * Check if a string is a valid UUID format.
 * Pure function - no side effects.
 */
export const isValidUuid = (value: string): boolean => {
  return UUID_REGEX.test(value)
}

/**
 * Zod schema for UUID validation.
 * Validates format and normalizes to lowercase.
 */
export const zUuid = z
  .string()
  .trim()
  .max(MAX_ID_LENGTH)
  .regex(UUID_REGEX, 'Invalid UUID format')
  .transform((val) => val.toLowerCase())

/**
 * Parse and validate an ID string.
 * Returns a Result type instead of throwing.
 *
 * Validation order:
 * 1. Type check (must be string)
 * 2. Empty check (after trim)
 * 3. Length check (max 100 chars)
 * 4. UUID format check
 *
 * @param value - The value to validate (accepts unknown for type safety)
 * @param fieldName - Name of the field for error messages
 * @returns IdParseResult with validated lowercase UUID or error
 */
export const parseId = (value: unknown, fieldName: string): IdParseResult => {
  // Type check
  if (typeof value !== 'string') {
    return {
      success: false,
      error: new IdValidationError(
        `${fieldName} must be a string`,
        'INVALID_TYPE',
        fieldName
      ),
    }
  }

  // Trim and empty check
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return {
      success: false,
      error: new IdValidationError(
        `${fieldName} cannot be empty`,
        'EMPTY_ID',
        fieldName
      ),
    }
  }

  // Length check (before regex to avoid ReDoS on very long strings)
  if (trimmed.length > MAX_ID_LENGTH) {
    return {
      success: false,
      error: new IdValidationError(
        `${fieldName} exceeds maximum length of ${MAX_ID_LENGTH} characters`,
        'ID_TOO_LONG',
        fieldName
      ),
    }
  }

  // UUID format check
  if (!isValidUuid(trimmed)) {
    return {
      success: false,
      error: new IdValidationError(
        `${fieldName} must be a valid UUID`,
        'INVALID_UUID_FORMAT',
        fieldName
      ),
    }
  }

  // Normalize to lowercase
  return { success: true, data: trimmed.toLowerCase() }
}

/**
 * Parse and validate a userId
 */
export const parseUserId = (value: unknown): IdParseResult => parseId(value, 'userId')

/**
 * Parse and validate a pageId
 */
export const parsePageId = (value: unknown): IdParseResult => parseId(value, 'pageId')

/**
 * Parse and validate a driveId
 */
export const parseDriveId = (value: unknown): IdParseResult => parseId(value, 'driveId')

/**
 * Convenience function to validate multiple IDs at once.
 * Returns the first error encountered or all validated IDs.
 */
export const parseIds = <T extends Record<string, unknown>>(
  ids: T
): { success: true; data: { [K in keyof T]: string } } | { success: false; error: IdValidationError } => {
  const result = {} as { [K in keyof T]: string }

  for (const [key, value] of Object.entries(ids)) {
    const parsed = parseId(value, key)
    if (!parsed.success) {
      return parsed
    }
    result[key as keyof T] = parsed.data
  }

  return { success: true, data: result }
}
