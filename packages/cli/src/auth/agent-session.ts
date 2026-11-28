/**
 * Silent refresh for an AI agent's own credential (ADR 0008; Agent Signup
 * Phase 5). An agent holds a durable secret, so a refresh token it can no
 * longer use is not a reason to stop: on `invalid_grant` — a refresh token
 * that expired, was rotated away by a crash between refresh and persist, or
 * was revoked by a secret rotation — the stored secret is exchanged again for
 * a fresh pair. A transient failure (network, 429, 5xx) is NOT a reason to
 * exchange: the refresh token may be fine, and the caller retries.
 *
 * Persist-before-use (ADR 0003 §3.5) is `OAuthTokenProvider`'s guarantee: the
 * provider awaits `onTokensUpdated` (which writes `agentCredentialWithTokens`)
 * before it hands the new access token to anyone.
 */
import { isInvalidGrantError } from '@pagespace/sdk';
import type { OAuthTokens, RefreshAccessToken } from '@pagespace/sdk';
import type { AgentHostCredential } from '../credentials/serialize.js';

export interface AgentRefreshDeps {
  readonly secret: string;
  /** The refresh_token grant (`silent-refresh.ts`). */
  readonly refresh: RefreshAccessToken;
  /** The jwt-bearer exchange of `secret` (`exchangeAgentAssertion`). */
  readonly exchange: (secret: string) => Promise<OAuthTokens>;
}

/** An empty refresh token means "none yet": the credential was stored before its first exchange. */
export function createAgentRefreshAccessToken(deps: AgentRefreshDeps): RefreshAccessToken {
  return async (refreshToken: string): Promise<OAuthTokens> => {
    if (refreshToken.length === 0) return deps.exchange(deps.secret);
    try {
      return await deps.refresh(refreshToken);
    } catch (error) {
      if (!isInvalidGrantError(error)) throw error;
      return deps.exchange(deps.secret);
    }
  };
}

/** Pure: the credential to persist after a refresh or exchange. Everything durable is kept. */
export function agentCredentialWithTokens(credential: AgentHostCredential, tokens: OAuthTokens, now: number): AgentHostCredential {
  return {
    ...credential,
    refreshToken: tokens.refreshToken,
    scopes: tokens.scope !== undefined ? tokens.scope.split(' ').filter(Boolean) : credential.scopes,
    createdAt: new Date(now).toISOString(),
  };
}
