'use client';

import { startAuthentication } from '@simplewebauthn/browser';
import { post } from '@/lib/auth/auth-fetch';

/**
 * Shared WebAuthn-attempt-then-magic-link-fallback flow (Phase 8 credential
 * minting security correction). `ConsentActions.tsx`, `ConnectedAppsList.tsx`,
 * and `MCPSettingsView.tsx` each gate a mutation behind a step-up grant and
 * previously carried near-identical copies of this ceremony — kept here once
 * so a future fix to the ceremony itself (as opposed to what each caller does
 * with the result) only has to land in one place.
 *
 * Callers own the actionBinding shape and the "awaiting email" UI/state
 * (e.g. which grant/token is pending, whether to persist that across a
 * magic-link redirect) — this only knows how to run the ceremony itself.
 */
export type StepUpAttempt = { status: 'ready'; stepUpToken: string } | { status: 'awaiting_email' };

const isNoPasskeyError = (error: unknown): boolean => error instanceof Error && error.message === 'no_passkey';

async function runWebauthnStepUp(actionBinding: Record<string, string>): Promise<string> {
  const { options } = await post<{ options: { challenge: string }; challengeId: string }>(
    '/api/auth/step-up/webauthn/options',
    { actionBinding },
  );
  const webauthnResponse = await startAuthentication({ optionsJSON: options as never });
  const { stepUpToken } = await post<{ stepUpToken: string }>('/api/auth/step-up/webauthn/verify', {
    response: webauthnResponse,
    expectedChallenge: options.challenge,
    actionBinding,
  });
  return stepUpToken;
}

async function requestMagicLinkStepUp(actionBinding: Record<string, string>, next: string): Promise<void> {
  await post('/api/auth/step-up/magic-link/request', { actionBinding, next });
}

/**
 * Attempts a WebAuthn step-up ceremony bound to `actionBinding`, falling back
 * to a single-use magic link (to the caller's own inbox) when they have no
 * registered passkey. Any other ceremony failure (most commonly the user
 * cancelling the browser's WebAuthn prompt) rethrows for the caller to
 * surface and reset its own UI state.
 */
export async function attemptStepUp(actionBinding: Record<string, string>, next: string): Promise<StepUpAttempt> {
  try {
    const stepUpToken = await runWebauthnStepUp(actionBinding);
    return { status: 'ready', stepUpToken };
  } catch (error) {
    if (!isNoPasskeyError(error)) throw error;
    await requestMagicLinkStepUp(actionBinding, next);
    return { status: 'awaiting_email' };
  }
}

const STEP_UP_TOKEN_HASH_PARAM = 'step_up_token';

function parseHashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/**
 * The magic-link verify route hands the grant back in the URL *fragment*
 * (`#step_up_token=...`), not the query string — fragments never leave the
 * browser, so the token can't be captured by server/proxy access logs.
 */
export function readStepUpTokenFromHash(hash: string): string | null {
  return parseHashParams(hash).get(STEP_UP_TOKEN_HASH_PARAM);
}

/** Builds the fragment with `step_up_token` removed, so it doesn't linger in history. */
export function stripStepUpTokenFromHash(hash: string): string {
  const params = parseHashParams(hash);
  params.delete(STEP_UP_TOKEN_HASH_PARAM);
  const remaining = params.toString();
  return remaining ? `#${remaining}` : '';
}
