/**
 * Polling the claim grant (auth.md "Fund"; Agent Signup Phase 4 contract):
 * while a human approves the agent's user code on `/claim`, the agent POSTs
 * `grant_type=urn:pagespace:agent-auth:grant-type:claim&claim_token=…&client_id=pagespace-agent`
 * to the token endpoint. Answers use the device-flow vocabulary —
 * `authorization_pending`, `slow_down`, `expired_token`, `access_denied` — and
 * an approval is `{ claimed: true, owner: { id, name }, ...tokens }`. A second
 * poll after redemption is `invalid_grant`.
 *
 * Every outcome is a value, never a throw, so the loop in `agent-claim-flow.ts`
 * decides without parsing strings. The claim token rides only in the form body.
 */
import { AGENT_CLAIM_GRANT_TYPE, parseBearerTokenResponse } from '@pagespace/sdk';
import type { OAuthTokens } from '@pagespace/sdk';

export interface ClaimOwner {
  readonly id: string;
  readonly name: string | null;
}

export type AgentClaimPollResult =
  | { readonly kind: 'authorization_pending' }
  | { readonly kind: 'slow_down' }
  | { readonly kind: 'expired_token' }
  | { readonly kind: 'access_denied' }
  | { readonly kind: 'invalid_grant' }
  | { readonly kind: 'request_failed'; readonly message: string }
  | { readonly kind: 'claimed'; readonly owner: ClaimOwner | null; readonly tokens: OAuthTokens | null };

export type PollAgentClaim = (params: { tokenEndpoint: string; claimToken: string; clientId: string }) => Promise<AgentClaimPollResult>;

const KNOWN_ERRORS = new Set(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant']);

function errorCode(json: unknown): string | null {
  if (json !== null && typeof json === 'object' && typeof (json as Record<string, unknown>).error === 'string') {
    return (json as Record<string, unknown>).error as string;
  }
  return null;
}

function ownerOf(json: Record<string, unknown>): ClaimOwner | null {
  const owner = json.owner;
  if (owner === null || typeof owner !== 'object') return null;
  const { id, name } = owner as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id, name: typeof name === 'string' ? name : null };
}

export function createPollAgentClaim(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): PollAgentClaim {
  return async ({ tokenEndpoint, claimToken, clientId }) => {
    const body = new URLSearchParams({ grant_type: AGENT_CLAIM_GRANT_TYPE, claim_token: claimToken, client_id: clientId });

    let response: Response;
    try {
      response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      return { kind: 'request_failed', message: `network_error: ${error instanceof Error ? error.message : String(error)}` };
    }

    const json: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const code = errorCode(json);
      if (code !== null && KNOWN_ERRORS.has(code)) {
        return { kind: code as 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant' };
      }
      return { kind: 'request_failed', message: code ?? `http_${response.status}` };
    }

    if (json === null || typeof json !== 'object' || (json as Record<string, unknown>).claimed !== true) {
      return { kind: 'request_failed', message: 'invalid_response' };
    }
    // The approval carries a fresh pair for the agent itself; a body without
    // one still means the claim settled (the agent's existing tokens survive a
    // claim, ADR 0008 Decision 7).
    let tokens: OAuthTokens | null = null;
    try {
      tokens = parseBearerTokenResponse(response.status, response.headers, json, 'auth.agentClaim', now);
    } catch {
      tokens = null;
    }
    return { kind: 'claimed', owner: ownerOf(json as Record<string, unknown>), tokens };
  };
}
