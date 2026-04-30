export const MAX_TAB_ID_LENGTH = 64;

// Matches cuid2-style ids the client emits (`getTabId()`); also tolerates hyphens
// and underscores so a future client encoding can land without a contract bump.
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type TabIdValidationError = 'missing' | 'too_long' | 'invalid_chars';

export type TabIdValidationResult =
  | { ok: true; tabId: string }
  | { ok: false; reason: TabIdValidationError; status: 400; message: string };

export const validateTabIdHeader = (raw: string | null): TabIdValidationResult => {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, reason: 'missing', status: 400, message: 'X-Tab-Id header is required' };
  }
  if (raw.length > MAX_TAB_ID_LENGTH) {
    return { ok: false, reason: 'too_long', status: 400, message: 'X-Tab-Id header exceeds maximum length' };
  }
  if (!TAB_ID_PATTERN.test(raw)) {
    return { ok: false, reason: 'invalid_chars', status: 400, message: 'X-Tab-Id header contains invalid characters' };
  }
  return { ok: true, tabId: raw };
};
