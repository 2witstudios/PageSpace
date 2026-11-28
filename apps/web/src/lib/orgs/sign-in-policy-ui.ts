/**
 * The org Security page's sign-in controls (SEC-2/SEC-3, UI-7; D-OW-45/D-OW-47). Pure.
 */
import {
  MAX_MAXIMUM_SESSION_AGE_MINUTES,
  MIN_MAXIMUM_SESSION_AGE_MINUTES,
  normalizeMaximumSessionAgeMinutes,
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

/**
 * A stored maximum age outside the allowed range (damaged; the policy GET reads it as the strictest value, 0) is shown
 * as invalid for the Admin to replace, never offered as a choice.
 */
export const isValidSessionAge = (minutes: number | null): boolean =>
  normalizeMaximumSessionAgeMinutes(minutes) !== undefined;

/**
 * The PATCH body: only the keys the Admin changed. Re-sending an unchanged key would re-validate it, so a damaged stored
 * age would refuse an unrelated change (and be judged as a change the Admin never made).
 */
export function signInPolicyPatch(stored: SignInPolicyDraft, draft: SignInPolicyDraft): Partial<SignInPolicyDraft> {
  const body: Partial<SignInPolicyDraft> = {};
  if (draft.requireStrongSignIn !== stored.requireStrongSignIn) body.requireStrongSignIn = draft.requireStrongSignIn;
  if (draft.maximumSessionAgeMinutes !== stored.maximumSessionAgeMinutes) body.maximumSessionAgeMinutes = draft.maximumSessionAgeMinutes;
  return body;
}

/** Who a sign-in policy would refuse, by count (the preview and the save result). */
export interface SignInBlockedCounts {
  members: number;
  guests: number;
  credentials: number;
}

const people = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 members", "1 guest", "2 members and 1 guest"; empty when nobody. */
export function blockedPeopleText(counts: Pick<SignInBlockedCounts, 'members' | 'guests'>): string {
  const parts = [
    counts.members > 0 ? people(counts.members, 'member', 'members') : null,
    counts.guests > 0 ? people(counts.guests, 'guest', 'guests') : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' and ');
}
