import { isCuid } from '@paralleldrive/cuid2'

/**
 * Maximum length for ID strings before format validation.
 * CUID2 IDs are ~25 characters. Allow generous buffer but reject absurdly long strings early.
 */
const MAX_ID_LENGTH = 100

/**
 * Error codes for ID validation failures
 */
export type IdValidationErrorCode =
  | 'INVALID_TYPE'
  | 'EMPTY_ID'
  | 'ID_TOO_LONG'
  | 'INVALID_ID_FORMAT'

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
 * Check if a string is a valid CUID2 format.
 * Uses the official isCuid validator from @paralleldrive/cuid2.
 */
export const isValidId = (value: string): boolean => {
  return isCuid(value)
}

/**
 * Parse and validate an ID string.
 * Returns a Result type instead of throwing.
 *
 * Validation order:
 * 1. Type check (must be string)
 * 2. Empty check (after trim)
 * 3. Length check (max 100 chars)
 * 4. CUID2 format check
 *
 * @param value - The value to validate (accepts unknown for type safety)
 * @param fieldName - Name of the field for error messages
 * @returns IdParseResult with validated ID or error
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

  // Length check (before format check to reject absurd inputs early)
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

  // CUID2 format check
  if (!isValidId(trimmed)) {
    return {
      success: false,
      error: new IdValidationError(
        `${fieldName} must be a valid CUID2 identifier`,
        'INVALID_ID_FORMAT',
        fieldName
      ),
    }
  }

  return { success: true, data: trimmed }
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
