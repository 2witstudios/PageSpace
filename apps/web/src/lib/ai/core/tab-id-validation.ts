export const MAX_TAB_ID_LENGTH = 64;

export type TabIdValidationError = 'missing' | 'too_long';

export const validateTabIdHeader = (raw: string | null): { ok: true; tabId: string } | { ok: false; reason: TabIdValidationError } => {
  if (!raw) return { ok: false, reason: 'missing' };
  if (raw.length > MAX_TAB_ID_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, tabId: raw };
};
