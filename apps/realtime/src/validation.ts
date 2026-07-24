/**
 * WebSocket Payload Validation
 *
 * Pure functions for validating socket event payloads.
 * Following Eric Elliott's functional programming principles:
 * - Pure predicates (no side effects)
 * - Composed validators
 * - Result types instead of exceptions
 */

// The CUID2 predicate is defined once, alongside the room grammar it guards,
// in @pagespace/lib/realtime/rooms (#2158) — re-exported here for the payload
// validators below and their existing consumers.
import { isCUID2 } from '@pagespace/lib/realtime/rooms';

export { isCUID2 };

/**
 * Result type for validation - avoids exceptions, explicit success/failure
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

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
  if (!isCUID2(input)) {
    return { ok: false, error: 'invalid Page ID format' };
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
  if (!isCUID2(input)) {
    return { ok: false, error: 'Drive ID must be a valid ID' };
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
  if (!isCUID2(input)) {
    return { ok: false, error: 'Conversation ID must be a valid ID' };
  }
  return { ok: true, value: input };
};

/**
 * Validates a presence payload containing { pageId: string }.
 * Extracts and validates the pageId from the object payload.
 * Returns Result type - never throws
 */
export const validatePresencePagePayload = (input: unknown): ValidationResult<string> => {
  if (!input || typeof input !== 'object' || !('pageId' in input)) {
    return { ok: false, error: 'Invalid payload: pageId required' };
  }
  return validatePageId((input as { pageId: string }).pageId);
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
