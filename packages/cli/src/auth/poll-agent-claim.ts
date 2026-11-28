/**
 * Polling the claim grant (auth.md "Fund"; ADR 0008 security review
 * addendum): while a human approves the agent's user code on `/claim`, the
 * agent POSTs `grant_type=urn:pagespace:agent-auth:grant-type:claim&client_id=pagespace-agent`
 * to the token endpoint with its OWN access token as `Authorization: Bearer`.
 * Answers use the device-flow vocabulary — `authorization_pending`,
 * `slow_down`, `expired_token`, `access_denied` — plus `invalid_grant` and
 * `invalid_token`; an approval is `{ claimed: true, owner: { id, name } }`
 * and mints NO token (the agent keeps its own, Decision 7).
 *
 * A thin adapter over the SDK's `pollAgentClaim`, injectable for the loop in
 * `commands/agent.ts`. Every outcome is a value, never a throw.
 */
import { pollAgentClaim } from '@pagespace/sdk';
import type { AgentClaimPollResult } from '@pagespace/sdk';

export type { AgentClaimPollResult };

export type PollAgentClaim = (params: { tokenEndpoint: string; accessToken: string; clientId: string }) => Promise<AgentClaimPollResult>;

export function createPollAgentClaim(fetchImpl: typeof fetch = fetch): PollAgentClaim {
  return ({ tokenEndpoint, accessToken, clientId }) => pollAgentClaim(tokenEndpoint, accessToken, clientId, { fetch: fetchImpl });
}
