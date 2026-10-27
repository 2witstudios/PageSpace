// Errors imago's API client rejects with. A request that never reaches the
// server rejects with fetch's own TypeError instead, so callers can tell
// "offline" from "the server said no".

/** Code for a response body imago could not use (not JSON, missing fields). */
export const INVALID_RESPONSE = 'INVALID_RESPONSE';

/** The 403 codes apps/web's CSRF check answers with (csrf-validation.ts). */
export const CSRF_REJECTION_CODES: ReadonlySet<string> = new Set([
  'CSRF_TOKEN_INVALID',
  'CSRF_TOKEN_MISSING',
]);

/** An HTTP answer imago treats as a failure, in apps/web's `{ error, code, details }` shape. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  /** apps/web's machine-readable `code`, e.g. `CSRF_TOKEN_INVALID`; null when it sent none. */
  readonly code: string | null;
  readonly details: string | null;

  constructor({
    status,
    code,
    message,
    details = null,
  }: {
    status: number;
    code: string | null;
    message: string;
    details?: string | null;
  }) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const stringField = (body: unknown, field: string): string | null => {
  if (typeof body !== 'object' || body === null || !(field in body)) return null;
  const value: unknown = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** The ApiError for a non-2xx response whose body (parsed JSON, or null) is given. */
export const apiErrorFrom = (status: number, body: unknown): ApiError =>
  new ApiError({
    status,
    code: stringField(body, 'code'),
    message: stringField(body, 'error') ?? `Request failed with status ${status}`,
    details: stringField(body, 'details'),
  });

export const isCsrfRejection = (status: number, body: unknown): boolean => {
  const code = stringField(body, 'code');
  return status === 403 && code !== null && CSRF_REJECTION_CODES.has(code);
};

/** The `csrfToken` field of apps/web's GET /api/auth/csrf answer, or null. */
export const csrfTokenOf = (body: unknown): string | null => stringField(body, 'csrfToken');
