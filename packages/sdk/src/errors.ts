/**
 * SDK error taxonomy (ADR 0001 D6; Phase 2 task 2).
 *
 * House convention (cf. packages/lib/src/services/validated-service-token.ts,
 * packages/lib/src/utils/fetch-with-timeout.ts): every error is a named
 * `class X extends Error` with a `readonly code` literal and a
 * realm-independent `isX` type guard — `instanceof` still works within a
 * realm (and is asserted in tests), but the guard is what cross-package/
 * cross-realm consumers (CLI, MCP adapter) should rely on.
 *
 * classifyHttpError is the pure, total classification core: status/headers/
 * body in, typed error out. It never throws — real servers return junk
 * bodies, HTML error pages, and empty responses, and classification must
 * survive all of them. It never copies unknown body/header fields into the
 * resulting error (zero trust: no oracle for tokens or secrets that a
 * misbehaving or compromised server echoes back).
 */

export type PageSpaceErrorCode =
  | 'AUTHENTICATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT_ERROR'
  | 'RESPONSE_VALIDATION_ERROR'
  | 'INCOMPATIBLE_SERVER';

export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
}

export type IncompatibilityReason =
  | 'missing-header'
  | 'malformed-version'
  | 'major-mismatch'
  | 'server-too-old';

export type CompatibilityResult =
  | { ok: true; serverVersion: string }
  | {
      ok: false;
      reason: IncompatibilityReason;
      serverVersion: string | null;
      sdkMinVersion: string;
    };

/** Base class for every error the SDK throws. Catch this to catch them all. */
export abstract class PageSpaceError extends Error {
  abstract readonly code: PageSpaceErrorCode;
  readonly operation: string | undefined;

  protected constructor(message: string, operation?: string) {
    super(message);
    this.name = new.target.name;
    this.operation = operation;
  }
}

export class AuthenticationError extends PageSpaceError {
  readonly code = 'AUTHENTICATION_ERROR' as const;
  readonly status = 401 as const;

  constructor(message: string, operation?: string) {
    super(message, operation);
  }
}

export class PermissionDeniedError extends PageSpaceError {
  readonly code = 'PERMISSION_DENIED' as const;
  readonly status = 403 as const;

  constructor(message: string, operation?: string) {
    super(message, operation);
  }
}

export class NotFoundError extends PageSpaceError {
  readonly code = 'NOT_FOUND' as const;
  readonly status = 404 as const;

  constructor(message: string, operation?: string) {
    super(message, operation);
  }
}

export class ValidationError extends PageSpaceError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly status = 400 as const;
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[], operation?: string) {
    super(message, operation);
    this.issues = issues;
  }
}

export class RateLimitError extends PageSpaceError {
  readonly code = 'RATE_LIMITED' as const;
  readonly status = 429 as const;
  readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null, operation?: string) {
    super(message, operation);
    this.retryAfterMs = retryAfterMs;
  }
}

export class ServerError extends PageSpaceError {
  readonly code = 'SERVER_ERROR' as const;
  readonly status: number;

  constructor(message: string, status: number, operation?: string) {
    super(message, operation);
    this.status = status;
  }
}

/** Fallback for any HTTP status not otherwise classified (e.g. 402, 409, unexpected 3xx). */
export class HttpError extends PageSpaceError {
  readonly code = 'HTTP_ERROR' as const;
  readonly status: number;

  constructor(message: string, status: number, operation?: string) {
    super(message, operation);
    this.status = status;
  }
}

export interface NetworkErrorOptions {
  operation?: string;
  cause?: unknown;
}

/** The request never produced an HTTP response (offline, DNS, connection reset, ...). */
export class NetworkError extends PageSpaceError {
  readonly code = 'NETWORK_ERROR' as const;
  readonly cause: unknown;

  constructor(message: string, options: NetworkErrorOptions = {}) {
    super(message, options.operation);
    this.cause = options.cause;
  }
}

export interface TimeoutErrorOptions {
  operation?: string;
  timeoutMs?: number;
}

/** The request was aborted because it exceeded its deadline. */
export class TimeoutError extends PageSpaceError {
  readonly code = 'TIMEOUT_ERROR' as const;
  readonly timeoutMs: number | undefined;

  constructor(message: string, options: TimeoutErrorOptions = {}) {
    super(message, options.operation);
    this.timeoutMs = options.timeoutMs;
  }
}

/**
 * The server-drift signal: a 2xx response whose body failed the operation's
 * zod output schema. Distinct from ValidationError (which classifies a 400
 * the server itself returned for a bad *request*).
 */
export class ResponseValidationError extends PageSpaceError {
  readonly code = 'RESPONSE_VALIDATION_ERROR' as const;
  readonly issues: ValidationIssue[];

  constructor(operation: string, issues: ValidationIssue[]) {
    super(`Response for operation "${operation}" did not match its output schema`, operation);
    this.issues = issues;
  }
}

/** Thrown per ADR 0001 D4/D6 when the server fails the compatibility check. */
export class IncompatibleServerError extends PageSpaceError {
  readonly code = 'INCOMPATIBLE_SERVER' as const;
  readonly reason: IncompatibilityReason;
  readonly serverVersion: string | null;
  readonly sdkMinVersion: string;

  constructor(result: Extract<CompatibilityResult, { ok: false }>) {
    super(
      `Incompatible server (${result.reason}): server reports "${result.serverVersion ?? 'none'}", ` +
        `SDK requires >= "${result.sdkMinVersion}"`,
    );
    this.reason = result.reason;
    this.serverVersion = result.serverVersion;
    this.sdkMinVersion = result.sdkMinVersion;
  }
}

// ---------------------------------------------------------------------------
// Realm-independent type guards (house convention: code + message shape,
// not instanceof — safe across bundled copies of this package).
// ---------------------------------------------------------------------------

function hasErrorCode(error: unknown, code: PageSpaceErrorCode): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

const PAGESPACE_ERROR_CODES: ReadonlySet<PageSpaceErrorCode> = new Set([
  'AUTHENTICATION_ERROR',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'HTTP_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT_ERROR',
  'RESPONSE_VALIDATION_ERROR',
  'INCOMPATIBLE_SERVER',
] satisfies PageSpaceErrorCode[]);

export function isPageSpaceError(error: unknown): error is PageSpaceError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    PAGESPACE_ERROR_CODES.has((error as { code: PageSpaceErrorCode }).code) &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

export function isAuthenticationError(error: unknown): error is AuthenticationError {
  return hasErrorCode(error, 'AUTHENTICATION_ERROR');
}

export function isPermissionDeniedError(error: unknown): error is PermissionDeniedError {
  return hasErrorCode(error, 'PERMISSION_DENIED');
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return hasErrorCode(error, 'NOT_FOUND');
}

export function isValidationError(error: unknown): error is ValidationError {
  return hasErrorCode(error, 'VALIDATION_ERROR');
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return hasErrorCode(error, 'RATE_LIMITED');
}

export function isServerError(error: unknown): error is ServerError {
  return hasErrorCode(error, 'SERVER_ERROR');
}

export function isHttpError(error: unknown): error is HttpError {
  return hasErrorCode(error, 'HTTP_ERROR');
}

export function isNetworkError(error: unknown): error is NetworkError {
  return hasErrorCode(error, 'NETWORK_ERROR');
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return hasErrorCode(error, 'TIMEOUT_ERROR');
}

export function isResponseValidationError(error: unknown): error is ResponseValidationError {
  return hasErrorCode(error, 'RESPONSE_VALIDATION_ERROR');
}

export function isIncompatibleServerError(error: unknown): error is IncompatibleServerError {
  return hasErrorCode(error, 'INCOMPATIBLE_SERVER');
}

// ---------------------------------------------------------------------------
// classifyHttpError — the pure classification core
// ---------------------------------------------------------------------------

export type HttpErrorHeaders = Headers | Record<string, string> | null | undefined;

/** Case-insensitive header lookup across both a real `Headers` and a plain record (house convention: tests use plain objects). */
export function getHeaderValue(headers: HttpErrorHeaders, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') {
    try {
      return (headers as Headers).get(name);
    } catch {
      return null;
    }
  }
  const record = headers as Record<string, string>;
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lowerName) {
      const value = record[key];
      return typeof value === 'string' ? value : null;
    }
  }
  return null;
}

/** Parses a Retry-After header (seconds, per house convention) into ms, or null if absent/invalid. */
function parseRetryAfterMs(headers: HttpErrorHeaders): number | null {
  const raw = getHeaderValue(headers, 'Retry-After');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extracts a safe string message from a response body, defaulting per status. */
function extractMessage(status: number, body: unknown): string {
  if (isPlainObject(body) && typeof body.error === 'string' && body.error.length > 0) {
    return body.error;
  }
  return `HTTP ${status}`;
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return (
    isPlainObject(value) &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string' || typeof segment === 'number') &&
    typeof value.message === 'string'
  );
}

/** Extracts zod-issue-shaped entries from body.error, dropping anything malformed. */
function extractValidationIssues(body: unknown): ValidationIssue[] {
  if (!isPlainObject(body) || !Array.isArray(body.error)) return [];
  return body.error
    .filter(isValidationIssue)
    .map((issue) => ({ path: [...issue.path], message: issue.message }));
}

/**
 * Pure, total classification: HTTP status + response headers + response body
 * → a typed PageSpaceError. Never throws.
 */
export function classifyHttpError(
  status: number,
  headers: HttpErrorHeaders,
  body: unknown,
  operation?: string,
): PageSpaceError {
  const message = extractMessage(status, body);

  switch (status) {
    case 401:
      return new AuthenticationError(message, operation);
    case 403:
      return new PermissionDeniedError(message, operation);
    case 404:
      return new NotFoundError(message, operation);
    case 400:
      return new ValidationError(message, extractValidationIssues(body), operation);
    case 429:
      return new RateLimitError(message, parseRetryAfterMs(headers), operation);
    default:
      if (status >= 500 && status <= 599) {
        return new ServerError(message, status, operation);
      }
      return new HttpError(message, status, operation);
  }
}
