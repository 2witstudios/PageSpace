/**
 * The org Security page's sign-in controls (SEC-2/SEC-3, UI-7; D-OW-45/D-OW-47). Pure.
 */
import {
  MAX_MAXIMUM_SESSION_AGE_MINUTES,
  MIN_MAXIMUM_SESSION_AGE_MINUTES,
} from '@pagespace/lib/organizations/authentication-policy-core';

/** The maximum ages offered, from the allowed range's floor (15 minutes) to its ceiling (30 days). */
export const SESSION_AGE_OPTIONS: readonly number[] = [
  MIN_MAXIMUM_SESSION_AGE_MINUTES, 30, 60, 4 * 60, 8 * 60, 12 * 60, 24 * 60, 7 * 24 * 60, MAX_MAXIMUM_SESSION_AGE_MINUTES,
];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Whole minutes in the largest unit that divides them: 15 minutes, 1 hour, 7 days. */
export function formatSessionAge(minutes: number): string {
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

export const SESSION_AGE_RANGE_TEXT =
  `From ${formatSessionAge(MIN_MAXIMUM_SESSION_AGE_MINUTES)} to ${formatSessionAge(MAX_MAXIMUM_SESSION_AGE_MINUTES)}.`;

export interface SignInPolicyDraft {
  requireStrongSignIn: boolean;
  maximumSessionAgeMinutes: number | null;
}

/**
 * D-OW-47: turning strong sign-in on needs the saving Admin to have signed in with a passkey, or they would lock
 * themselves out — so the page runs the passkey ceremony BEFORE saving.
 */
export const needsPasskeyBeforeSaving = (stored: SignInPolicyDraft, draft: SignInPolicyDraft): boolean =>
  !stored.requireStrongSignIn && draft.requireStrongSignIn;

/** The preview query for GET .../policies/sign-in-preview. */
export function signInPreviewQuery(draft: SignInPolicyDraft): string {
  const params = new URLSearchParams({ requireStrongSignIn: String(draft.requireStrongSignIn) });
  if (draft.maximumSessionAgeMinutes !== null) params.set('maximumSessionAgeMinutes', String(draft.maximumSessionAgeMinutes));
  return params.toString();
}
