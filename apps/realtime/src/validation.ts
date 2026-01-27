/**
 * WebSocket Payload Validation
 *
 * Pure functions for validating socket event payloads.
 * Following Eric Elliott's functional programming principles:
 * - Pure predicates (no side effects)
 * - Composed validators
 * - Result types instead of exceptions
 */

// UUID v4 regex pattern - matches standard UUID format
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Max length check before regex to prevent ReDoS
const MAX_UUID_LENGTH = 36;

/**
 * Result type for validation - avoids exceptions, explicit success/failure
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Type guard: checks if input is a valid UUID v4 string
 * Pure predicate - no side effects
 */
export const isUUID = (input: unknown): input is string => {
  if (typeof input !== 'string') return false;
  if (input.length > MAX_UUID_LENGTH) return false;
  return UUID_REGEX.test(input);
};

/**
 * Higher-order function: creates a length validator
 * Pure - returns a predicate function
 */
export const isNotTooLong =
  (max: number) =>
  (input: string): boolean =>
    input.length <= max;

/**
 * Validates a page ID payload
 * Returns Result type - never throws
 */
export const validatePageId = (input: unknown): ValidationResult<string> => {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Page ID must be a string' };
  }
  if (!isUUID(input)) {
    return { ok: false, error: 'invalid Page ID format - must be a UUID' };
  }
  return { ok: true, value: input };
};

/**
 * Validates a drive ID payload
 * Returns Result type - never throws
 */
export const validateDriveId = (input: unknown): ValidationResult<string> => {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Drive ID must be a string' };
  }
  if (!isUUID(input)) {
    return { ok: false, error: 'Drive ID must be a valid UUID' };
  }
  return { ok: true, value: input };
};

/**
 * Validates a conversation ID payload
 * Returns Result type - never throws
 */
export const validateConversationId = (input: unknown): ValidationResult<string> => {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Conversation ID must be a string' };
  }
  if (!isUUID(input)) {
    return { ok: false, error: 'Conversation ID must be a valid UUID' };
  }
  return { ok: true, value: input };
};

/**
 * Socket type for validation error emission
 */
interface SocketLike {
  emit: (event: string, data: unknown) => void;
}

/**
 * Emits a validation error to the client
 * Side effect function - kept separate from pure validation logic
 */
export const emitValidationError = (
  socket: SocketLike,
  event: string,
  error: string
): void => {
  socket.emit('validation_error', { event, error });
};
