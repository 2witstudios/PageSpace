/**
 * Pure helper for the consent screen's inline step-up ceremony (Phase 8 task
 * d2wicbqyia6u30axz8j2j4ab). Kept separate from `ConsentActions.tsx` so the
 * decision logic — what the step-up grant is bound to — is unit-testable
 * without rendering React. The ceremony itself (WebAuthn-attempt-then-magic-
 * link-fallback, hash parsing, no-passkey detection) lives once in
 * `@/lib/auth/step-up-ceremony` and is shared by every step-up call site —
 * this module used to carry its own copies of those helpers, which is why a
 * fix to that ceremony code once had to be manually re-verified per call site.
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
