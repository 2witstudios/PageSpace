'use client';

import { fetchJSON, post } from '@/lib/auth/auth-fetch';
import { attemptStepUp, readStepUpTokenFromHash, runWebauthnStepUp, stripStepUpTokenFromHash } from '@/lib/auth/step-up-ceremony';
import type { OrgSignInDenialCode } from '@/lib/auth/org-sign-in-denial';

/**
 * Re-running a sign-in ceremony for the CURRENT session (D-OW-45). Reuses the step-up ceremony, bound to this session
 * (GET /api/auth/reauthenticate), then asks the server to stamp the evidence the ceremony earned
 * (POST /api/auth/reauthenticate). The client never says what it proved; the server reads it from the grant.
 *
 *   - strong sign-in: a passkey with user verification, nothing else (an emailed link would not satisfy it);
 *   - maximum age: the person's passkey, or an emailed link when they have none.
 */
export type SessionReauthOutcome = { status: 'done' } | { status: 'awaiting_email' };

/** Where an emailed confirmation link lands: inside the app shell, so the prompt can finish the job there. */
export const REAUTH_RETURN_PATH = '/dashboard?reauthenticate=1';

async function actionBinding(): Promise<Record<string, string>> {
  const { actionBinding: binding } = await fetchJSON<{ actionBinding: Record<string, string> }>('/api/auth/reauthenticate');
  return binding;
}

export async function reauthenticateCurrentSession(requirement: OrgSignInDenialCode): Promise<SessionReauthOutcome> {
  const binding = await actionBinding();
  if (requirement === 'org_strong_sign_in_required') {
    await post('/api/auth/reauthenticate', { stepUpToken: await runWebauthnStepUp(binding) });
    return { status: 'done' };
  }
  const attempt = await attemptStepUp(binding, REAUTH_RETURN_PATH);
  if (attempt.status === 'awaiting_email') return attempt;
  await post('/api/auth/reauthenticate', { stepUpToken: attempt.stepUpToken });
  return { status: 'done' };
}

/**
 * The landing half of the emailed link: on `?reauthenticate=1` with a `#step_up_token=…` fragment, stamp the grant on
 * this session and strip the token from the address bar. False when there was nothing to finish.
 */
export async function completeEmailedReauthentication(location: Pick<Location, 'search' | 'hash' | 'pathname'>): Promise<boolean> {
  if (new URLSearchParams(location.search).get('reauthenticate') !== '1') return false;
  const stepUpToken = readStepUpTokenFromHash(location.hash);
  if (!stepUpToken) return false;
  window.history.replaceState(null, '', `${location.pathname}${stripStepUpTokenFromHash(location.hash)}`);
  await post('/api/auth/reauthenticate', { stepUpToken });
  return true;
}
