/**
 * Start a claim for an agent that is signed in by SESSION (Agent Signup Phase
 * 3, ADR 0008 Decision 3). The API door starts a claim by presenting the
 * `claim_token` (`POST /api/agent/claim`, Phase 4). An agent that signed in at
 * the browser door with its secret holds a cookie, not that token — so the
 * session itself is its proof, and this starts the SAME kind of claim: one
 * `agent_claims` row with a fresh user code a human enters at `/claim`.
 *
 * Only an unclaimed, unrevoked agent whose claim token has not been spent can
 * start one (approval nulls `claimTokenHash`, assertion 22). The user code is
 * stored as `hashToken(normalizeUserCode(code))`, the device flow's convention,
 * so `/claim` finds it the same way it finds an API-door claim.
 */
import { startAgentClaimForAgent } from '@/lib/repositories/agent-claim-repository';
import { CLAIM_TTL_SECONDS } from '@pagespace/lib/auth/agent/claim-decision';
import { AgentIdentityStoreError } from '@pagespace/lib/services/agent-identities';
import { redactDbError } from '@pagespace/lib/logging/db-error-redaction';
import { loggers } from '@pagespace/lib/logging/logger-config';

type StartSessionClaimResult =
  | { ok: true; userCode: string; expiresAt: Date }
  | { ok: false; error: 'already_claimed' | 'not_claimable' };

/**
 * Delegates to the claim repository's `startAgentClaimForAgent` (Phase 4) —
 * the same core the API door uses: the identity row locked FOR UPDATE, any
 * pending claim superseded, the claim row keyed by the identity's claim-token
 * hash so the claim grant can poll it. One code path, so a session-started
 * claim behaves exactly like a token-started one at `/claim`, approval and poll.
 */
export async function startAgentClaimForSession(input: { agentUserId: string; now: Date }): Promise<StartSessionClaimResult> {
  try {
    const started = await startAgentClaimForAgent(input);
    if (started.outcome === 'already_claimed') return { ok: false, error: 'already_claimed' };
    if (started.outcome !== 'ok') return { ok: false, error: 'not_claimable' };
    return { ok: true, userCode: started.userCode, expiresAt: new Date(input.now.getTime() + CLAIM_TTL_SECONDS * 1000) };
  } catch (error) {
    // The insert binds a user-code and claim-token hash: never let the raw query error out.
    const redacted = redactDbError(error);
    loggers.auth.error('Agent identity store failed', { operation: 'start_session_claim', ...redacted });
    throw new AgentIdentityStoreError('start_session_claim', redacted);
  }
}
