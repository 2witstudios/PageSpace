/**
 * Hidden field name a bot fills in but a real browser form leaves untouched
 * (styled off-screen in the generated form HTML — see `form-html.ts`).
 */
export const HONEYPOT_FIELD_NAME = '_hp';

/**
 * A submission is spam if the honeypot field carries any non-empty value —
 * any type, since a scripted submitter may send it as a non-string.
 */
export function isHoneypotTriggered(payload: Record<string, unknown>): boolean {
  const value = payload[HONEYPOT_FIELD_NAME];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}
