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
import { randomBytes } from 'crypto';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { agentClaims, agentIdentities } from '@pagespace/db/schema/agent-identities';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { generateUserCode, normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { CLAIM_POLL_INTERVAL_SECONDS, CLAIM_TTL_SECONDS } from '@pagespace/lib/auth/agent/claim-decision';
import { AgentIdentityStoreError } from '@pagespace/lib/services/agent-identities';
import { redactDbError } from '@pagespace/lib/logging/db-error-redaction';
import { loggers } from '@pagespace/lib/logging/logger-config';

type StartSessionClaimResult =
  | { ok: true; userCode: string; expiresAt: Date }
  | { ok: false; error: 'already_claimed' | 'not_claimable' };

export async function startAgentClaimForSession(input: { agentUserId: string; now: Date }): Promise<StartSessionClaimResult> {
  try {
    const [identity] = await db
      .select({
        ownerUserId: agentIdentities.ownerUserId,
        revokedAt: agentIdentities.revokedAt,
        claimTokenHash: agentIdentities.claimTokenHash,
      })
      .from(agentIdentities)
      .where(eq(agentIdentities.userId, input.agentUserId))
      .limit(1);

    if (!identity || identity.revokedAt !== null) return { ok: false, error: 'not_claimable' };
    if (identity.ownerUserId !== null) return { ok: false, error: 'already_claimed' };
    if (identity.claimTokenHash === null) return { ok: false, error: 'not_claimable' };

    const userCode = generateUserCode(randomBytes);
    const expiresAt = new Date(input.now.getTime() + CLAIM_TTL_SECONDS * 1000);
    await db.insert(agentClaims).values({
      agentUserId: input.agentUserId,
      userCodeHash: hashToken(normalizeUserCode(userCode)),
      expiresAt,
      pollIntervalSeconds: CLAIM_POLL_INTERVAL_SECONDS,
    });
    return { ok: true, userCode, expiresAt };
  } catch (error) {
    // The insert binds a user-code hash: never let the raw query error out.
    const redacted = redactDbError(error);
    loggers.auth.error('Agent identity store failed', { operation: 'start_session_claim', ...redacted });
    throw new AgentIdentityStoreError('start_session_claim', redacted);
  }
}
