/**
 * Agent identities — an AI agent's own PageSpace login (ADR 0007).
 *
 * The adapter over Phase 0's frozen decisions: it persists what
 * `mintAgentSecret`, `agentSyntheticEmail` and `decideAgentSignin` imply and
 * decides nothing itself. Routes (Phase 2 API door, Phase 3 browser door)
 * run `decideAgentSignup` BEFORE calling `createAgentAccount`; this service
 * still consumes the challenge atomically, because a lookup-then-consume
 * across two statements is exactly the replay window threat model T2 closes.
 *
 * Not to be confused with `packages/lib/src/agent-accounts/` (the credential
 * broker, ADR 0004/0005): those are credentials an agent holds for OTHER sites.
 *
 * @module @pagespace/lib/services/agent-identities
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, isNull, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentIdentities, agentSignupChallenges } from '@pagespace/db/schema/agent-identities';
import { createId } from '@paralleldrive/cuid2';
import { prepareUserWrite } from '../auth/user-repository';
import { generateToken, hashToken } from '../auth/token-utils';
import { mintAgentSecret, isAgentSecretShape } from '../auth/agent/secret';
import { agentSyntheticEmail } from '../auth/agent/reserved-email';
import { decideAgentSignin, type AgentSigninDecision } from '../auth/agent/signin-decision';
import { provisionHomeDriveIfNeeded } from '../onboarding/home-drive';
import { loggers } from '../logging/logger-config';

/** Prefix of the claim token an agent hands a human (auth.md "Fund"). Hash-only at rest. */
export const AGENT_CLAIM_TOKEN_PREFIX = 'ps_claim';

export interface CreateAgentAccountInput {
  name: string;
  /** Self-reported client label, ≤120 chars (validated by the route). */
  source: string | null;
  tosAcceptedAt: Date;
  createdByIp: string | null;
  challengeId: string;
  now: Date;
}

export type CreateAgentAccountResult =
  | {
      ok: true;
      data: {
        userId: string;
        email: string;
        /** Plaintext `ps_agent_*` secret — return it to the agent ONCE, never log or store it. */
        secret: string;
        secretPrefix: string;
        /** Plaintext claim token — returned once, hash-only at rest. */
        claimToken: string;
      };
    }
  | { ok: false; error: 'challenge_invalid' };

/** Rolls the transaction back when the challenge was not consumable. */
class ChallengeUnavailable extends Error {}

/**
 * Create an agent: consume the challenge, insert the `users` row and the
 * identity row in ONE transaction, then provision the home drive. Two racing
 * submits of one challenge serialise on the challenge row: the loser's UPDATE
 * re-checks `consumedAt IS NULL` after the winner commits and matches nothing.
 */
export async function createAgentAccount(input: CreateAgentAccountInput): Promise<CreateAgentAccountResult> {
  const userId = createId();
  const email = agentSyntheticEmail(userId);
  const minted = mintAgentSecret();
  const claim = generateToken(AGENT_CLAIM_TOKEN_PREFIX);

  try {
    await db.transaction(async (tx) => {
      const consumed = await tx
        .update(agentSignupChallenges)
        .set({ consumedAt: input.now })
        .where(and(
          eq(agentSignupChallenges.id, input.challengeId),
          isNull(agentSignupChallenges.consumedAt),
          gt(agentSignupChallenges.expiresAt, input.now),
        ))
        .returning({ id: agentSignupChallenges.id });
      if (consumed.length !== 1) throw new ChallengeUnavailable();

      const newUser: typeof users.$inferInsert = {
        id: userId,
        name: input.name,
        email,
        emailVerified: null, // D-31 option A: an unclaimed agent cannot initiate DMs, invites or uploads
        provider: 'email',
        role: 'user',
        accountType: 'agent',
        tokenVersion: 1,
        tosAcceptedAt: input.tosAcceptedAt,
      };
      await tx.insert(users).values(await prepareUserWrite(newUser));

      await tx.insert(agentIdentities).values({
        userId,
        secretHash: minted.hash,
        secretPrefix: minted.prefix,
        claimTokenHash: claim.hash,
        claimTokenPrefix: claim.tokenPrefix,
        source: input.source,
        createdByIp: input.createdByIp,
      });
    });
  } catch (error) {
    if (error instanceof ChallengeUnavailable) return { ok: false, error: 'challenge_invalid' };
    throw error;
  }

  // The account is committed, and the secret below exists nowhere else — a
  // provisioning failure must not throw it away. `provisionHomeDriveIfNeeded`
  // is idempotent, so a later sign-in can retry it (passkey signup's posture).
  try {
    await provisionHomeDriveIfNeeded(userId);
  } catch (error) {
    loggers.auth.error('Failed to provision Home drive for agent', error as Error, { userId });
  }

  return {
    ok: true,
    data: { userId, email, secret: minted.secret, secretPrefix: minted.prefix, claimToken: claim.token },
  };
}

export interface VerifyAgentSecretResult {
  /** Typed for audit and lockout; routes collapse it with `collapseAgentSigninDecision`. */
  decision: AgentSigninDecision;
  /** Set whenever the secret matched a row, so the route can audit the real subject. */
  userId: string | null;
}

/**
 * Look an agent up by the SHA3-256 hash of a presented secret and decide.
 * A malformed secret never reaches the database. On `ok`, `lastAuthAt` is
 * stamped (the lifecycle decision keys on it).
 */
export async function verifyAgentSecret(input: { secret: string; now: Date }): Promise<VerifyAgentSecretResult> {
  if (!isAgentSecretShape(input.secret)) {
    return { decision: decideAgentSignin({ account: { found: false }, now: input.now }), userId: null };
  }

  const [row] = await db
    .select({
      userId: agentIdentities.userId,
      revokedAt: agentIdentities.revokedAt,
      suspendedAt: users.suspendedAt,
      lockedUntil: users.lockedUntil,
    })
    .from(agentIdentities)
    .innerJoin(users, eq(users.id, agentIdentities.userId))
    .where(eq(agentIdentities.secretHash, hashToken(input.secret)))
    .limit(1);

  if (!row) {
    return { decision: decideAgentSignin({ account: { found: false }, now: input.now }), userId: null };
  }

  const decision = decideAgentSignin({
    account: { found: true, revokedAt: row.revokedAt, suspendedAt: row.suspendedAt, lockedUntil: row.lockedUntil },
    now: input.now,
  });

  if (decision.status === 'ok') {
    await db.update(agentIdentities).set({ lastAuthAt: input.now }).where(eq(agentIdentities.userId, row.userId));
  }

  return { decision, userId: row.userId };
}

export type RotateAgentSecretResult =
  | { ok: true; data: { secret: string; secretPrefix: string; secretVersion: number } }
  | { ok: false; error: 'not_found' };

/**
 * Replace a live agent's secret (ADR 0007 Decision 14). The old secret stops
 * matching immediately. `revokeTokens` also bumps `users.tokenVersion` so
 * every live `ps_at_`/`ps_rt_` minted before the rotation dies.
 */
export async function rotateAgentSecret(input: { userId: string; revokeTokens: boolean }): Promise<RotateAgentSecretResult> {
  const minted = mintAgentSecret();

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(agentIdentities)
      .set({
        secretHash: minted.hash,
        secretPrefix: minted.prefix,
        secretVersion: sql`${agentIdentities.secretVersion} + 1`,
      })
      .where(and(eq(agentIdentities.userId, input.userId), isNull(agentIdentities.revokedAt)))
      .returning({ secretVersion: agentIdentities.secretVersion });
    if (!updated) return { ok: false, error: 'not_found' } as const;

    if (input.revokeTokens) {
      await tx.update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, input.userId));
    }

    return {
      ok: true,
      data: { secret: minted.secret, secretPrefix: minted.prefix, secretVersion: updated.secretVersion },
    } as const;
  });
}

/**
 * Revoke an agent: `revokedAt` is set and `users.tokenVersion` bumped in one
 * transaction, so the secret stops signing in AND live tokens die (a control
 * must reach where the effect lives). Revoking an already revoked agent is a
 * no-op that reports `revoked: false`.
 */
export async function revokeAgent(input: { userId: string; now: Date }): Promise<{ revoked: boolean }> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(agentIdentities)
      .set({ revokedAt: input.now })
      .where(and(eq(agentIdentities.userId, input.userId), isNull(agentIdentities.revokedAt)))
      .returning({ userId: agentIdentities.userId });
    if (updated.length === 0) return { revoked: false };

    await tx.update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, input.userId));
    return { revoked: true };
  });
}

export interface AgentIdentitySummary {
  ownerUserId: string | null;
  claimedAt: Date | null;
  source: string | null;
}

/** The ownership facts `/api/auth/me` exposes for an agent; `null` for anyone without an identity row. */
export async function getAgentIdentitySummary(userId: string): Promise<AgentIdentitySummary | null> {
  const [row] = await db
    .select({
      ownerUserId: agentIdentities.ownerUserId,
      claimedAt: agentIdentities.claimedAt,
      source: agentIdentities.source,
    })
    .from(agentIdentities)
    .where(eq(agentIdentities.userId, userId))
    .limit(1);
  return row ?? null;
}
