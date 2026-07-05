/**
 * Pure helpers for the consent screen's inline step-up ceremony
 * (Phase 8 task d2wicbqyia6u30axz8j2j4ab). Kept separate from
 * `ConsentActions.tsx` so the decision logic — what to bind on, how to read
 * a magic-link-carried token back out of the URL, how to recognize the
 * passkey-less fallback signal — is unit-testable without rendering React.
 */

export interface ConsentActionBindingParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string | undefined;
}

/**
 * Mirrors the server's own binding exactly (`apps/web/src/app/api/oauth/authorize/route.ts`'s
 * `{ clientId: body.clientId, redirectUri: body.redirectUri, scope: body.scope, state: body.state ?? '' }`)
 * so a grant requested here can only ever be spent on this exact approval.
 */
export const buildConsentActionBinding = ({
  clientId,
  redirectUri,
  scope,
  state,
}: ConsentActionBindingParams): Record<string, string> => ({
  clientId,
  redirectUri,
  scope,
  state: state ?? '',
});

const STEP_UP_TOKEN_PARAM = 'step_up_token';

export const readStepUpTokenFromSearch = (search: string): string | null =>
  new URLSearchParams(search).get(STEP_UP_TOKEN_PARAM);

/** Builds the query string with `step_up_token` removed, so it doesn't linger in history/referrers. */
export const stripStepUpTokenFromSearch = (search: string): string => {
  const params = new URLSearchParams(search);
  params.delete(STEP_UP_TOKEN_PARAM);
  const remaining = params.toString();
  return remaining ? `?${remaining}` : '';
};

/** The `webauthn/options` route's signal that this user has no registered passkey. */
export const isNoPasskeyError = (error: unknown): boolean => error instanceof Error && error.message === 'no_passkey';
