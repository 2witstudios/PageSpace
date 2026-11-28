/**
 * Start a claim for the CALLING agent (ADR 0008 Decision 3 and the security
 * review addendum). Both doors land here once `resolveClaimCaller` has proven
 * the caller is the agent itself: `POST /api/agent/claim` with the agent's own
 * `pagespace-agent` access token, and `POST /api/agent/claim/session` with its
 * browser session. There is no claim token: the agent's own credential is the
 * only thing that can start a claim for it.
 *
 * Only an unclaimed, unrevoked, unsuspended agent can start one. The user code
 * is stored as `hashToken(normalizeUserCode(code))`, the device flow's
 * convention, so `/claim` finds it whichever door started it.
 */
import { startAgentClaimForAgent } from '@/lib/repositories/agent-claim-repository';
import { CLAIM_TTL_SECONDS } from '@pagespace/lib/auth/agent/claim-decision';
import { AgentIdentityStoreError } from '@pagespace/lib/services/agent-identities';
import { redactDbError } from '@pagespace/lib/logging/db-error-redaction';
import { loggers } from '@pagespace/lib/logging/logger-config';

type StartOwnClaimResult =
  | { ok: true; userCode: string; expiresAt: Date }
  | { ok: false; error: 'already_claimed' | 'not_claimable' };

export async function startOwnAgentClaim(input: { agentUserId: string; now: Date }): Promise<StartOwnClaimResult> {
  try {
    const started = await startAgentClaimForAgent(input);
    if (started.outcome === 'already_claimed') return { ok: false, error: 'already_claimed' };
    if (started.outcome !== 'ok') return { ok: false, error: 'not_claimable' };
    return { ok: true, userCode: started.userCode, expiresAt: new Date(input.now.getTime() + CLAIM_TTL_SECONDS * 1000) };
  } catch (error) {
    // The insert binds a user-code hash: never let the raw query error out.
    const redacted = redactDbError(error);
    loggers.auth.error('Agent identity store failed', { operation: 'start_claim', ...redacted });
    throw new AgentIdentityStoreError('start_claim', redacted);
  }
}
