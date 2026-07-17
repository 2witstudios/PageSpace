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
 *
 * `body.message` is only ever trusted for the KNOWN_CODES branch below — that
 * shape comes exclusively from our own `credit-gate-response.ts`, a controlled,
 * backend-authored contract. Every other branch (401/429-generic/5xx/default)
 * can be fed by an arbitrary upstream provider error or infra failure, so those
 * always render the local default copy — trusting an arbitrary server-supplied
 * string there could crash rendering or leak internal error details into the UI
 * (PR 6 review, CodeRabbit).
 */
export const toErrorCause = (httpStatus: number, body: unknown): AIErrorCause => {
  const rawCode = stringField(body, 'error');

  if (rawCode && KNOWN_CODES.has(rawCode as AIErrorCause['code'])) {
    const serverMessage = stringField(body, 'message');
    return buildErrorCause(rawCode as AIErrorCause['code'], httpStatus, serverMessage);
  }

  if (httpStatus === 401) return buildErrorCause('auth', httpStatus, undefined, false);
  if (httpStatus === 429) return buildErrorCause('rate_limit', httpStatus, undefined, true);
  // 5xx with no recognizable code is a transient server failure — retryable.
  if (httpStatus >= 500) return buildErrorCause('unknown', httpStatus, undefined, true);

  return buildErrorCause('unknown', httpStatus, undefined, false);
};
