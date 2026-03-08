const MAX_ENDPOINT_LENGTH = 256;
const MAX_ERROR_LENGTH = 1024;
const MAX_STACK_LENGTH = 4096;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_DURATION_MS = 300000; // 5 minutes

export interface IngestPayload {
  type: 'api-request';
  requestId?: string;
  timestamp?: string;
  method: string;
  endpoint: string;
  statusCode: number;
  duration: number;
  requestSize?: number;
  responseSize?: number;
  userId?: string;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  error?: string;
  errorName?: string;
  errorStack?: string;
  cacheHit?: boolean;
  cacheKey?: string;
  driveId?: string;
  pageId?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

export function redactUrlQueryParams(url: string): string {
  if (!url) return '';

  // Handle full URLs
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      return parsed.pathname;
    } catch {
      // Fall through to simple stripping
    }
  }

  // Strip query string and fragment from path
  const queryIdx = url.indexOf('?');
  const hashIdx = url.indexOf('#');
  const cutIdx = Math.min(
    queryIdx >= 0 ? queryIdx : url.length,
    hashIdx >= 0 ? hashIdx : url.length,
  );
  return url.slice(0, cutIdx);
}

export function sanitizeEndpoint(endpoint: string): string {
  if (!endpoint) return '';
  let clean = redactUrlQueryParams(endpoint);
  // Normalize double slashes (but preserve leading slash)
  clean = clean.replace(/\/\/+/g, '/');
  if (clean.length > MAX_ENDPOINT_LENGTH) {
    clean = clean.slice(0, MAX_ENDPOINT_LENGTH);
  }
  return clean;
}

export function truncateString(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sanitizeIngestPayload(payload: IngestPayload): IngestPayload {
  return {
    ...payload,
    endpoint: sanitizeEndpoint(payload.endpoint),
    duration: clampNumber(payload.duration, 0, MAX_DURATION_MS),
    error: truncateString(payload.error, MAX_ERROR_LENGTH),
    errorStack: truncateString(payload.errorStack, MAX_STACK_LENGTH),
    userAgent: truncateString(payload.userAgent, MAX_USER_AGENT_LENGTH),
    query: undefined,
  };
}
