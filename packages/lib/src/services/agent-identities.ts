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
import { and, eq, gt, inArray, isNull, lt, lte, sql } from '@pagespace/db/operators';
import { users, mcpTokens } from '@pagespace/db/schema/auth';
import { agentIdentities, agentSignupChallenges } from '@pagespace/db/schema/agent-identities';
import { createId } from '@paralleldrive/cuid2';
import { prepareUserWrite } from '../auth/user-repository';
import { generateToken, hashToken } from '../auth/token-utils';
import { mintAgentSecret, isAgentSecretShape } from '../auth/agent/secret';
import { agentSyntheticEmail } from '../auth/agent/reserved-email';
import { decideAgentSignin, type AgentSigninDecision } from '../auth/agent/signin-decision';
import {
  AGENT_SIGNUP_BUDGET_WINDOW_MS,
  AGENT_SIGNUP_GLOBAL_BUDGET,
  decideAgentSignupBudget,
} from '../auth/agent/signup-budget';
import { provisionHomeDriveIfNeeded } from '../onboarding/home-drive';
import { loggers } from '../logging/logger-config';
import { redactDbError, type RedactedDbError } from '../logging/db-error-redaction';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Thrown in place of any query error from this service. Every write here binds
 * a credential hash (`secretHash`, `claimTokenHash`, `challengeHash`), and
 * drizzle's `DrizzleQueryError` message is the query plus its bound params —
 * so the original error must never be logged or rethrown to a route (Next
 * logs an uncaught route error in full). This one's message is constant and
 * it carries no `cause`; the redacted code and constraint are on the instance.
 */
export class AgentIdentityStoreError extends Error {
  constructor(readonly operation: string, readonly redacted: RedactedDbError) {
    super(`Agent identity store failed: ${operation}`);
    this.name = 'AgentIdentityStoreError';
  }
}

function storeFailure(operation: string, error: unknown): AgentIdentityStoreError {
  const redacted = redactDbError(error);
  loggers.auth.error('Agent identity store failed', { operation, ...redacted });
  return new AgentIdentityStoreError(operation, redacted);
}

/** Runs one store operation; any query error leaves as an `AgentIdentityStoreError`. */
async function guardStore<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ChallengeUnavailable) throw error;
    throw storeFailure(operation, error);
  }
}

/** Prefix of the claim token an agent hands a human (auth.md "Fund"). Hash-only at rest. */
export const AGENT_CLAIM_TOKEN_PREFIX = 'ps_claim';

/** Prefix of a proof-of-work challenge. Hash-only at rest. */
export const AGENT_POW_CHALLENGE_PREFIX = 'ps_pow';

export interface IssuedAgentSignupChallenge {
  /** Plaintext challenge — returned to the caller once; only its hash is stored. */
  challenge: string;
  expiresAt: Date;
}

/** How many expired challenges one issuance deletes. */
const CHALLENGE_PRUNE_BATCH = 100;

/**
 * Persist a single-use proof-of-work challenge (ADR 0007 Decision 10, threat
 * model T2). The difficulty is stored on the row so a later change to
 * `AGENT_SIGNUP_POW_BITS` never re-grades a challenge already handed out.
 *
 * Each issuance first deletes up to CHALLENGE_PRUNE_BATCH expired challenges,
 * claimed with FOR UPDATE SKIP LOCKED so concurrent issuances take disjoint
 * batches. Every row is written by an issuance and each issuance can delete
 * more than one, so expired rows cannot accumulate without a cron, even
 * under a burst. No caller IP is stored: redemption is deliberately not bound
 * to the issuing address (Phase 2b), so it would be PII with no purpose. An expired row is worthless: the lookup treats it exactly like an
 * unknown challenge. A prune failure never blocks issuing.
 */
export async function issueAgentSignupChallenge(input: {
  difficultyBits: number;
  ttlMs: number;
  now: Date;
}): Promise<IssuedAgentSignupChallenge> {
  try {
    const expired = db
      .select({ id: agentSignupChallenges.id })
      .from(agentSignupChallenges)
      .where(lt(agentSignupChallenges.expiresAt, input.now))
      .orderBy(agentSignupChallenges.expiresAt)
      .limit(CHALLENGE_PRUNE_BATCH)
      // Concurrent issuances claim DISJOINT batches: without SKIP LOCKED every
      // request in a burst selects the same oldest rows, one deletes them, the
      // rest delete nothing (or wait) — and all of them insert.
      .for('update', { skipLocked: true });
    await db.delete(agentSignupChallenges).where(inArray(agentSignupChallenges.id, expired));
  } catch (error) {
    loggers.auth.warn('Failed to prune expired agent signup challenges', redactDbError(error));
  }

  const generated = generateToken(AGENT_POW_CHALLENGE_PREFIX);
  const expiresAt = new Date(input.now.getTime() + input.ttlMs);
  await guardStore('issue_challenge', () => db.insert(agentSignupChallenges).values({
    challengeHash: generated.hash,
    difficultyBits: input.difficultyBits,
    expiresAt,
  }));
  return { challenge: generated.token, expiresAt };
}

/** The facts `decideAgentSignup` needs about a presented challenge, plus the row id to consume. */
export type AgentSignupChallengeLookup =
  | { found: false; expired: false; consumed: false; difficultyBits: 0; id: null }
  | { found: true; expired: boolean; consumed: boolean; difficultyBits: number; id: string };

const CHALLENGE_NOT_FOUND = { found: false, expired: false, consumed: false, difficultyBits: 0, id: null } as const;

/**
 * Look a presented challenge up by hash. Reports facts only; `decideAgentSignup`
 * orders them, and `createAgentAccount` re-checks expiry and consumption
 * atomically, so this read is never the thing that admits a replay.
 */
export async function findAgentSignupChallenge(input: { challenge: string; now: Date }): Promise<AgentSignupChallengeLookup> {
  if (typeof input.challenge !== 'string' || input.challenge.length === 0 || input.challenge.length > 256) {
    return CHALLENGE_NOT_FOUND;
  }
  const [row] = await guardStore('find_challenge', () => db
    .select({
      id: agentSignupChallenges.id,
      difficultyBits: agentSignupChallenges.difficultyBits,
      expiresAt: agentSignupChallenges.expiresAt,
      consumedAt: agentSignupChallenges.consumedAt,
    })
    .from(agentSignupChallenges)
    .where(eq(agentSignupChallenges.challengeHash, hashToken(input.challenge)))
    .limit(1));
  if (!row) return CHALLENGE_NOT_FOUND;
  return {
    found: true,
    // Same boundary as createAgentAccount's `expiresAt > now`: expiring exactly now is expired.
    expired: row.expiresAt.getTime() <= input.now.getTime(),
    consumed: row.consumedAt !== null,
    difficultyBits: row.difficultyBits,
    id: row.id,
  };
}

export interface CreateAgentAccountInput {
  name: string;
  /** Self-reported client label, ≤120 chars (validated by the route). */
  source: string | null;
  tosAcceptedAt: Date;
  createdByIp: string | null;
  challengeId: string;
  now: Date;
  /** Deployment-wide budget override (tests); defaults to `AGENT_SIGNUP_GLOBAL_BUDGET`. */
  budget?: number;
  /** Rolling window override (tests); defaults to `AGENT_SIGNUP_BUDGET_WINDOW_MS`. */
  budgetWindowMs?: number;
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
  | { ok: false; error: 'challenge_invalid' }
  | { ok: false; error: 'signup_budget_exhausted'; retryAfterSeconds: number };

/** Rolls the transaction back when the challenge was not consumable. */
class ChallengeUnavailable extends Error {}

/** Rolls the transaction back when the deployment-wide signup budget is spent. */
class SignupBudgetExhausted extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('agent signup budget exhausted');
  }
}

/**
 * Serialises every agent signup's budget check + insert, so N concurrent
 * signups cannot all count the same N-1 and overshoot. Signups are rare and
 * the lock is held for one transaction.
 */
const SIGNUP_BUDGET_LOCK = sql`select pg_advisory_xact_lock(hashtext('agent_signup_budget'))`;

/**
 * Create an agent: check the deployment-wide signup budget, consume the
 * challenge, insert the `users` row and the identity row in ONE transaction,
 * then provision the home drive. Two racing submits of one challenge serialise
 * on the challenge row: the loser's UPDATE re-checks `consumedAt IS NULL` after
 * the winner commits and matches nothing.
 *
 * The budget (`decideAgentSignupBudget`) lives here rather than in a route so
 * that no door can skip it: it counts identities created in the rolling window
 * under an advisory lock, and a refusal rolls back before the challenge is
 * consumed.
 */
export async function createAgentAccount(input: CreateAgentAccountInput): Promise<CreateAgentAccountResult> {
  const userId = createId();
  const email = agentSyntheticEmail(userId);
  const minted = mintAgentSecret();
  const claim = generateToken(AGENT_CLAIM_TOKEN_PREFIX);

  try {
    await db.transaction(async (tx) => {
      await tx.execute(SIGNUP_BUDGET_LOCK);
      const windowMs = input.budgetWindowMs ?? AGENT_SIGNUP_BUDGET_WINDOW_MS;
      const [recent] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          oldest: sql<Date | null>`min(${agentIdentities.createdAt})`.mapWith(agentIdentities.createdAt),
        })
        .from(agentIdentities)
        .where(and(
          gt(agentIdentities.createdAt, new Date(input.now.getTime() - windowMs)),
          lte(agentIdentities.createdAt, input.now),
        ));
      const budget = decideAgentSignupBudget({
        signupsInWindow: recent?.count ?? 0,
        oldestInWindow: recent?.oldest ?? null,
        budget: input.budget ?? AGENT_SIGNUP_GLOBAL_BUDGET,
        windowMs,
        now: input.now,
      });
      if (!budget.allowed) throw new SignupBudgetExhausted(budget.retryAfterSeconds);

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
        // Set from the caller's clock, not the column default: the budget
        // window above compares against `input.now`, and a DB-side now() is
        // rendered in the session time zone.
        createdAt: input.now,
      });
    });
  } catch (error) {
    if (error instanceof ChallengeUnavailable) return { ok: false, error: 'challenge_invalid' };
    if (error instanceof SignupBudgetExhausted) {
      return { ok: false, error: 'signup_budget_exhausted', retryAfterSeconds: error.retryAfterSeconds };
    }
    throw storeFailure('create_account', error);
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

  const [row] = await guardStore('verify_secret', () => db
    .select({
      userId: agentIdentities.userId,
      revokedAt: agentIdentities.revokedAt,
      suspendedAt: users.suspendedAt,
      lockedUntil: users.lockedUntil,
    })
    .from(agentIdentities)
    .innerJoin(users, eq(users.id, agentIdentities.userId))
    .where(eq(agentIdentities.secretHash, hashToken(input.secret)))
    .limit(1));

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
 * Every live credential an agent holds carries `users.tokenVersion` — except
 * its `mcp_` keys, which have no version column and are checked only against
 * `mcp_tokens.revokedAt`. So "kill every live token" for an agent means BOTH:
 * bump the version (sessions, `ps_at_`, `ps_rt_`) AND revoke its keys, in the
 * same transaction. Without the second half a key minted with a leaked secret
 * outlives the rotation or revocation meant to stop it.
 */
async function killAgentCredentials(tx: Tx, userId: string, now: Date): Promise<void> {
  // ORDER IS LOAD-BEARING: the version bump comes first because it takes the
  // lock on the users row that an in-flight agent key mint holds
  // (createAgentMcpTokenGuarded). Waiting here means the key revoke below runs
  // after that mint commits and so sees — and revokes — the key it inserted.
  // Revoking keys first would miss it.
  await tx.update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, userId));
  await tx.update(mcpTokens)
    .set({ revokedAt: now })
    .where(and(eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)));
}

/**
 * Replace a live agent's secret (ADR 0007 Decision 14). The old secret stops
 * matching immediately. `revokeTokens` also kills every live credential the
 * agent holds — sessions, `ps_at_`/`ps_rt_` and its `mcp_` keys.
 */
export async function rotateAgentSecret(input: { userId: string; revokeTokens: boolean; now?: Date }): Promise<RotateAgentSecretResult> {
  const minted = mintAgentSecret();

  return guardStore('rotate_secret', () => db.transaction(async (tx) => {
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
      await killAgentCredentials(tx, input.userId, input.now ?? new Date());
    }

    return {
      ok: true,
      data: { secret: minted.secret, secretPrefix: minted.prefix, secretVersion: updated.secretVersion },
    } as const;
  }));
}

/**
 * Revoke an agent: `revokedAt` is set and every live credential killed (see
 * `killAgentCredentials`) in one transaction, so the secret stops signing in
 * AND live tokens and keys die (a control
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

    await killAgentCredentials(tx, input.userId, input.now);
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
