/**
 * Token issuance for the OAuth 2.1 provider (ADR 0003 §3.1-3.3, Phase 1
 * task 7). Mints a brand-new refresh-token family for an authorization_code
 * exchange: opaque `ps_at_*` / `ps_rt_*` tokens via `generateOpaqueToken`
 * (SHA3-256 hashed at rest, raw value returned exactly once), bound to
 * `(userId, clientId, scopes, familyId)`.
 *
 * `issuedTokenLifetimes` is pure date math (no I/O) so the rotation grant
 * (task 8) can reuse it unchanged when re-issuing within an existing family.
 * `issueInitialTokenPair` is the impure edge — it calls the CSPRNG (via
 * `generateOpaqueToken`) and a clock (`now`, injected) to mint the family's
 * first token pair. The caller persists the returned rows; this module never
 * touches the database.
 *
 * @module @pagespace/lib/auth/oauth/issue-tokens
 */
import { createId } from '@paralleldrive/cuid2';
import { generateOpaqueToken } from '../opaque-tokens';

/** ADR 0003 §3.2 frozen lifetimes. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_TOKEN_FAMILY_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface IssuedTokenLifetimes {
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

/**
 * ADR 0003 §6: access always `now + 15m`; refresh is `min(now + 30d,
 * familyExpiresAt)` so a per-token TTL can never outlive the family's
 * absolute cap fixed at first issuance.
 */
export function issuedTokenLifetimes(now: Date, familyExpiresAt: Date): IssuedTokenLifetimes {
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const candidateRefreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  const refreshExpiresAt =
    candidateRefreshExpiresAt.getTime() < familyExpiresAt.getTime() ? candidateRefreshExpiresAt : familyExpiresAt;
  return { accessExpiresAt, refreshExpiresAt };
}

export interface IssuedTokenPair {
  accessToken: string;
  accessTokenHash: string;
  accessTokenPrefix: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshTokenHash: string;
  refreshTokenPrefix: string;
  refreshExpiresAt: Date;
  familyId: string;
  familyExpiresAt: Date;
}

/**
 * Mint the initial token pair for a brand-new refresh-token family — the
 * authorization_code grant always starts a family, it never rotates one.
 * `familyExpiresAt` is fixed here, at first issuance, and is never extended
 * (ADR 0003 §3.2-3.3): every later rotation clamps its refresh TTL against
 * this same absolute boundary.
 */
export function issueInitialTokenPair(now: Date): IssuedTokenPair {
  const familyId = createId();
  const familyExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_FAMILY_TTL_SECONDS * 1000);
  const { accessExpiresAt, refreshExpiresAt } = issuedTokenLifetimes(now, familyExpiresAt);

  const access = generateOpaqueToken('at');
  const refresh = generateOpaqueToken('rt');

  return {
    accessToken: access.token,
    accessTokenHash: access.tokenHash,
    accessTokenPrefix: access.tokenPrefix,
    accessExpiresAt,
    refreshToken: refresh.token,
    refreshTokenHash: refresh.tokenHash,
    refreshTokenPrefix: refresh.tokenPrefix,
    refreshExpiresAt,
    familyId,
    familyExpiresAt,
  };
}
