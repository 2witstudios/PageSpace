export const MAX_TAB_ID_LENGTH = 64;

export type TabIdValidationError = 'missing' | 'too_long';

export type TabIdValidationResult =
  | { ok: true; tabId: string }
  | { ok: false; reason: TabIdValidationError; status: 400; message: string };

export const validateTabIdHeader = (raw: string | null): TabIdValidationResult => {
  if (!raw) {
    return { ok: false, reason: 'missing', status: 400, message: 'X-Tab-Id header is required' };
  }
  if (raw.length > MAX_TAB_ID_LENGTH) {
    return { ok: false, reason: 'too_long', status: 400, message: 'X-Tab-Id header exceeds maximum length' };
  }
  return { ok: true, tabId: raw };
};
