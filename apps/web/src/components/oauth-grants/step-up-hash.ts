/**
 * Pure helpers for picking a step-up grant back out of the URL after the
 * magic-link fallback ceremony redirects here (Phase 8 task
 * cg0aqe6bu21qg2tj7lgswf38). Mirrors the OAuth consent screen's own
 * `consent-step-up.ts` helpers, kept as a separate module here rather than
 * imported from there so this settings-page feature doesn't take a
 * cross-surface dependency on the consent screen's internals.
 */

const STEP_UP_TOKEN_HASH_PARAM = 'step_up_token';

function parseHashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

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

/** The `webauthn/options` route's signal that this user has no registered passkey. */
export function isNoPasskeyError(error: unknown): boolean {
  return error instanceof Error && error.message === 'no_passkey';
}
