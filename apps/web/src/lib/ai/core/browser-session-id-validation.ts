export const MAX_BROWSER_SESSION_ID_LENGTH = 64;

const BROWSER_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type BrowserSessionIdValidationError = 'missing' | 'too_long' | 'invalid_chars';

export type BrowserSessionIdValidationResult =
  | { ok: true; browserSessionId: string }
  | { ok: false; reason: BrowserSessionIdValidationError; status: 400; message: string };

export const validateBrowserSessionIdHeader = (raw: string | null): BrowserSessionIdValidationResult => {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, reason: 'missing', status: 400, message: 'X-Browser-Session-Id header is required' };
  }
  if (raw.length > MAX_BROWSER_SESSION_ID_LENGTH) {
    return { ok: false, reason: 'too_long', status: 400, message: 'X-Browser-Session-Id header exceeds maximum length' };
  }
  if (!BROWSER_SESSION_ID_PATTERN.test(raw)) {
    return { ok: false, reason: 'invalid_chars', status: 400, message: 'X-Browser-Session-Id header contains invalid characters' };
  }
  return { ok: true, browserSessionId: raw };
};
