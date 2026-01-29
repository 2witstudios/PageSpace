import { createId } from '@paralleldrive/cuid2';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Validates a request ID to prevent header injection attacks.
 * Accepts alphanumeric characters, hyphens, and underscores.
 * Max length 128 characters.
 */
export const isValidRequestId = (id: string | null | undefined): boolean => {
  if (!id || typeof id !== 'string' || id.length === 0) {
    return false;
  }

  if (id.length > 128) {
    return false;
  }

  // Only allow alphanumeric, hyphens, and underscores
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  return validPattern.test(id);
};

/**
 * Extracts request ID from incoming headers or generates a new one.
 * Supports distributed tracing by preserving upstream request IDs.
 *
 * @param request - The incoming request
 * @returns The request ID (existing or newly generated)
 */
export const getOrCreateRequestId = (request: Request): string => {
  const existingId = request.headers.get(REQUEST_ID_HEADER);

  if (isValidRequestId(existingId)) {
    return existingId!;
  }

  return createId();
};

/**
 * Creates a new unique request ID.
 */
export const createRequestId = (): string => createId();
