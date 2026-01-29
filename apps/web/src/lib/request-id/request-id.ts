import { createId, isCuid } from '@paralleldrive/cuid2';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Validates a request ID using the official CUID2 validator.
 */
export const isValidRequestId = (id: string | null | undefined): boolean => {
  if (!id || typeof id !== 'string') {
    return false;
  }
  return isCuid(id);
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
