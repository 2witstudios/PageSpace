import type { AIErrorCause } from './aiErrorCause';

export const DEFAULT_ERROR_MESSAGES: Record<AIErrorCause['code'], string> = {
  auth: 'Authentication failed. Please refresh the page and try again.',
  out_of_credits: "You've used up your credits. Buy more credits or wait for your monthly allowance to reset.",
  too_many_in_flight: 'Too many AI requests are running at once. Wait for one to finish, then try again.',
  daily_cap_exceeded: "You've reached your daily AI usage limit. Try again tomorrow.",
  rate_limit: 'The AI service is busy right now. Please try again in a few seconds.',
  unknown: 'Something went wrong. Please try again.',
};

export const RETRYABLE_BY_CODE: Record<AIErrorCause['code'], boolean> = {
  auth: false,
  out_of_credits: false,
  too_many_in_flight: true,
  daily_cap_exceeded: false,
  rate_limit: true,
  unknown: false,
};

const KNOWN_CODES = new Set<AIErrorCause['code']>([
  'out_of_credits',
  'too_many_in_flight',
  'daily_cap_exceeded',
]);

const stringField = (body: unknown, key: string): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
};

export const buildErrorCause = (
  code: AIErrorCause['code'],
  httpStatus: number | null,
  serverMessage: string | undefined,
  retryable: boolean = RETRYABLE_BY_CODE[code],
): AIErrorCause => ({
  code,
  httpStatus,
  message: serverMessage ?? DEFAULT_ERROR_MESSAGES[code],
  retryable,
});

/**
 * Classifies an AI route's error response into a typed cause (epic leaf 6.5) —
 * the server already sends a machine code (`credit-gate-response.ts`), so this
 * never needs to string-sniff. Never throws: a malformed/non-object/missing
 * body always resolves to a safe 'unknown' cause with friendly copy.
 */
export const toErrorCause = (httpStatus: number, body: unknown): AIErrorCause => {
  const rawCode = stringField(body, 'error');
  const serverMessage = stringField(body, 'message');

  if (rawCode && KNOWN_CODES.has(rawCode as AIErrorCause['code'])) {
    return buildErrorCause(rawCode as AIErrorCause['code'], httpStatus, serverMessage);
  }

  if (httpStatus === 401) return buildErrorCause('auth', httpStatus, serverMessage, false);
  if (httpStatus === 429) return buildErrorCause('rate_limit', httpStatus, serverMessage, true);
  // 5xx with no recognizable code is a transient server failure — retryable.
  if (httpStatus >= 500) return buildErrorCause('unknown', httpStatus, serverMessage, true);

  return buildErrorCause('unknown', httpStatus, serverMessage, false);
};
