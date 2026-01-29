import { createId } from '@paralleldrive/cuid2';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Validates a request ID to prevent header injection attacks.
 * Accepts alphanumeric characters, hyphens, and underscores up to 128 chars.
 */
export const isValidRequestId = (id: string | null | undefined): boolean => {
  if (!id || typeof id !== 'string' || id.length === 0) {
    return false;
  }

  if (id.length > 128) {
    return false;
  }

  const validPattern = /^[a-zA-Z0-9_-]+$/;
  return validPattern.test(id);
};

/**
 * Extracts request ID from incoming headers or generates a new one.
 * Supports distributed tracing by preserving upstream request IDs.
 */
export const getOrCreateRequestId = (request: Request): string => {
  const existingId = request.headers.get(REQUEST_ID_HEADER);

  if (isValidRequestId(existingId)) {
    return existingId!;
  }

  return createId();
};

export const createRequestId = (): string => createId();
