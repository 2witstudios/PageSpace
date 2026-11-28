/**
 * Persistence for the agent CLAIM ceremony (ADR 0008 Decisions 3, 7, 8;
 * auth.md "Fund"; Agent Signup Phase 4; security review addendum).
 *
 *   agent:  POST /api/agent/claim (its own Bearer)    → startAgentClaimForAgent (a user code)
 *   agent:  POST /api/agent/claim/session (cookie)   → startAgentClaimForAgent (same core)
 *   human:  /claim → verify                           → verifyAgentClaimUserCode
 *   human:  /claim → approve / deny                   → recordAgentClaimDecision
 *   agent:  /api/oauth/token grant_type=…:claim       → pollAgentClaim    ({claimed, owner} — no tokens)
 *
 * The shape mirrors the device-code functions in `oauth-repository.ts`, but a
 * claim is deliberately its own table, and unlike a device code it MINTS
 * NOTHING: the agent keeps the tokens it already holds (Decision 7), and the
 * claim only links an owner. Starting and polling are keyed by the agent's own
 * id, which the route proved from the agent's own credential
 * (`resolveClaimCaller`) — there is no claim token, so nothing a human or a
 * third party could hold starts, polls or redeems a claim for an agent.
 *
 * Every decision is Phase 0's frozen `decideClaimApproval` / `decideClaimPoll`
 * (and `decideAgentSignin` for "is this agent still usable"), taken inside one
 * transaction with the claim row AND the agent's identity row locked
 * `FOR UPDATE` — so two humans approving at once, an approval racing a poll,
 * or a poll racing a revoke/unlink all serialise, and the decision always
 * reads the agent's CURRENT owner. This module only maps rows to the
 * decisions' records and persists what they imply.
 *
 * Queries bind a user-code hash. A database error is left to the caller's
 * redacting handler (`isDatabaseError` → constant 503), exactly as the token
 * endpoint does.
 */

import { randomBytes } from 'crypto';
import { db } from '@pagespace/db/db';
import { and, desc, eq, isNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentClaims, agentIdentities } from '@pagespace/db/schema/agent-identities';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { generateUserCode, normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import {
  CLAIM_POLL_INTERVAL_SECONDS,
  CLAIM_TTL_SECONDS,
  decideClaimApproval,
  decideClaimPoll,
  type ClaimApprovalAction,
  type ClaimApprovalDecision,
  type ClaimRecord,
} from '@pagespace/lib/auth/agent/claim-decision';
import { decideAgentSignin } from '@pagespace/lib/auth/agent/signin-decision';
import { decryptUserRow } from '@pagespace/lib/auth/user-repository';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** How many fresh user codes a start tries before giving up (the space is 32^8). */
const USER_CODE_ATTEMPTS = 5;

interface ClaimRow {
  id: string;
  agentUserId: string;
  ownerUserId: string | null;
  expiresAt: Date;
  approvedAt: Date | null;
  deniedAt: Date | null;
  redeemedAt: Date | null;
  lastPolledAt: Date | null;
  pollIntervalSeconds: number;
}

const CLAIM_COLUMNS = {
  id: agentClaims.id,
  agentUserId: agentClaims.agentUserId,
  ownerUserId: agentClaims.ownerUserId,
  expiresAt: agentClaims.expiresAt,
  approvedAt: agentClaims.approvedAt,
  deniedAt: agentClaims.deniedAt,
  redeemedAt: agentClaims.redeemedAt,
  lastPolledAt: agentClaims.lastPolledAt,
  pollIntervalSeconds: agentClaims.pollIntervalSeconds,
};

/**
 * Map a claim row onto the frozen `ClaimRecord` union. `agentOwnerUserId` is
 * the agent's CURRENT owner from its (locked) identity row, never the claim's
 * own `ownerUserId` — that is what lets `decideClaimPoll` refuse a stale grant
 * after an unlink. Redemption is checked first, as `toDeviceCodeRecord` does:
 * a redeemed claim must never read back as freshly approved.
 */
export function toClaimRecord(row: ClaimRow, agentOwnerUserId: string | null): ClaimRecord {
  const common = {
    agentUserId: row.agentUserId,
    agentOwnerUserId,
    expiresAt: row.expiresAt,
    lastPolledAt: row.lastPolledAt,
    pollIntervalSeconds: row.pollIntervalSeconds,
  };
  if (row.redeemedAt !== null) return { status: 'redeemed', ...common };
  if (row.deniedAt !== null) return { status: 'denied', ...common };
  if (row.approvedAt !== null && row.ownerUserId !== null) return { status: 'approved', ownerUserId: row.ownerUserId, ...common };
  return { status: 'pending', ...common };
}

async function lockIdentity(tx: Tx, agentUserId: string) {
  const [identity] = await tx
    .select({
      ownerUserId: agentIdentities.ownerUserId,
      revokedAt: agentIdentities.revokedAt,
      suspendedAt: users.suspendedAt,
      lockedUntil: users.lockedUntil,
    })
    .from(agentIdentities)
    .innerJoin(users, eq(users.id, agentIdentities.userId))
    .where(eq(agentIdentities.userId, agentUserId))
    .limit(1)
    .for('update');
  return identity ?? null;
}

// ---------------------------------------------------------------------------
// Start (the agent)
// ---------------------------------------------------------------------------

export type StartAgentClaimResult =
  | { outcome: 'ok'; agentUserId: string; userCode: string; expiresInSeconds: number; intervalSeconds: number }
  /** The agent asking about ITSELF already has an owner (it can read that from /api/auth/me). */
  | { outcome: 'already_claimed' }
  /** Unknown, revoked or suspended — one outcome, one wire answer. */
  | { outcome: 'invalid' };

/**
 * Supersede (deny) every claim the agent left open — so exactly ONE claim per
 * agent can ever be approved, and an older code a human approves later is
 * `already_settled`, never an approval the agent's poll cannot see.
 */
async function denyOpenClaims(tx: Tx, agentUserId: string, now: Date): Promise<void> {
  await tx
    .update(agentClaims)
    .set({ deniedAt: now })
    .where(and(
      eq(agentClaims.agentUserId, agentUserId),
      isNull(agentClaims.approvedAt),
      isNull(agentClaims.deniedAt),
      isNull(agentClaims.redeemedAt),
    ));
}

/**
 * The ONE way a claim starts, whichever door the agent came through (its
 * Bearer at `POST /api/agent/claim`, its session at `/api/agent/claim/session`).
 * The caller is the agent itself — the route proved that from the agent's own
 * credential (`resolveClaimCaller`) — so its id is the only key: the identity
 * row is locked FOR UPDATE, any claim it left open is superseded, and a new
 * claim is inserted under a fresh user code.
 */
export async function startAgentClaimForAgent(input: { agentUserId: string; now: Date }): Promise<StartAgentClaimResult> {
  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select({
        userId: agentIdentities.userId,
        ownerUserId: agentIdentities.ownerUserId,
        revokedAt: agentIdentities.revokedAt,
        suspendedAt: users.suspendedAt,
      })
      .from(agentIdentities)
      .innerJoin(users, eq(users.id, agentIdentities.userId))
      .where(eq(agentIdentities.userId, input.agentUserId))
      .limit(1)
      .for('update');
    if (!identity || identity.revokedAt !== null || identity.suspendedAt !== null) return { outcome: 'invalid' } as const;
    if (identity.ownerUserId !== null) return { outcome: 'already_claimed' } as const;

    await denyOpenClaims(tx, identity.userId, input.now);

    const expiresAt = new Date(input.now.getTime() + CLAIM_TTL_SECONDS * 1000);
    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt += 1) {
      const userCode = generateUserCode(randomBytes);
      const inserted = await tx
        .insert(agentClaims)
        .values({
          agentUserId: identity.userId,
          userCodeHash: hashToken(normalizeUserCode(userCode)),
          expiresAt,
          pollIntervalSeconds: CLAIM_POLL_INTERVAL_SECONDS,
          createdAt: input.now,
        })
        .onConflictDoNothing({ target: agentClaims.userCodeHash })
        .returning({ id: agentClaims.id });
      if (inserted.length === 1) {
        return {
          outcome: 'ok',
          agentUserId: identity.userId,
          userCode,
          expiresInSeconds: CLAIM_TTL_SECONDS,
          intervalSeconds: CLAIM_POLL_INTERVAL_SECONDS,
        } as const;
      }
    }
    throw new Error('Agent claim user code space exhausted');
  });
}

// ---------------------------------------------------------------------------
// Verify (the human, read-only)
// ---------------------------------------------------------------------------

export interface ClaimableAgent {
  agentUserId: string;
  name: string;
  createdAt: Date;
  source: string | null;
}

export type VerifyAgentClaimResult =
  | { outcome: 'ok'; agent: ClaimableAgent }
  /** The signed-in claimer is not a human — an agent can never own an agent. */
  | { outcome: 'not_human' }
  /** Unknown, expired, settled, revoked or already-claimed — nothing to act on. */
  | { outcome: 'not_found' };

/**
 * What the /claim screen shows before the human decides: the agent's name,
 * when it was created and its self-reported source. Read-only; the frozen
 * `decideClaimApproval` is asked "would approving succeed?" against the same
 * facts the decision route will lock and re-read, so the screen never offers a
 * claim the server would refuse. Only `not_human` is told apart — it is a fact
 * about the CALLER, not about the code.
 */
export async function verifyAgentClaimUserCode(input: { userCode: string; claimerUserId: string; now: Date }): Promise<VerifyAgentClaimResult> {
  const userCodeHash = hashToken(normalizeUserCode(input.userCode));
  const [row] = await db
    .select({
      ...CLAIM_COLUMNS,
      agentOwnerUserId: agentIdentities.ownerUserId,
      revokedAt: agentIdentities.revokedAt,
      source: agentIdentities.source,
      agentCreatedAt: agentIdentities.createdAt,
      name: users.name,
    })
    .from(agentClaims)
    .innerJoin(agentIdentities, eq(agentIdentities.userId, agentClaims.agentUserId))
    .innerJoin(users, eq(users.id, agentClaims.agentUserId))
    .where(eq(agentClaims.userCodeHash, userCodeHash))
    .limit(1);
  if (!row || row.revokedAt !== null) return { outcome: 'not_found' };

  const claimer = await readClaimer(db, input.claimerUserId);
  if (!claimer) return { outcome: 'not_found' };

  const decision = decideClaimApproval(toClaimRecord(row, row.agentOwnerUserId), 'approve', claimer, input.now);
  if (decision.status === 'not_human') return { outcome: 'not_human' };
  if (decision.status !== 'approved') return { outcome: 'not_found' };

  const decrypted = await decryptUserRow({ name: row.name });
  return {
    outcome: 'ok',
    agent: { agentUserId: row.agentUserId, name: decrypted.name, createdAt: row.agentCreatedAt, source: row.source },
  };
}

async function readClaimer(executor: Tx | typeof db, userId: string) {
  const [row] = await executor.select({ accountType: users.accountType }).from(users).where(eq(users.id, userId)).limit(1);
  return row ? { userId, accountType: row.accountType } : null;
}

// ---------------------------------------------------------------------------
// Decide (the human)
// ---------------------------------------------------------------------------

export type RecordAgentClaimDecisionResult =
  | { outcome: 'approved'; agentUserId: string }
  | { outcome: 'denied'; agentUserId: string }
  | { outcome: 'not_found' }
  /** The frozen decision refused (not_human, already_claimed, already_settled, expired) — typed for the audit row. */
  | { outcome: 'refused'; agentUserId: string; decision: Exclude<ClaimApprovalDecision, { status: 'approved' } | { status: 'denied' }> };

/**
 * Record a human's approve/deny under `FOR UPDATE` on the claim AND the
 * agent's identity. On approval, in ONE transaction (ADR 0008 §5 assertion 22,
 * as amended by the security review addendum): the claim is approved for this
 * owner; the identity gets `ownerUserId` and `claimedAt` (no other claim of the
 * agent's is open: starting a claim supersedes every earlier one); and the agent's `users.emailVerified` is stamped (D-31 option A — an unclaimed
 * agent cannot initiate DMs, invites or uploads; a claimed one can).
 * Pre-claim tokens are untouched (Decision 7): nothing here bumps tokenVersion.
 */
export async function recordAgentClaimDecision(input: {
  userCode: string;
  action: ClaimApprovalAction;
  claimerUserId: string;
  now: Date;
}): Promise<RecordAgentClaimDecisionResult> {
  const userCodeHash = hashToken(normalizeUserCode(input.userCode));

  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select(CLAIM_COLUMNS)
      .from(agentClaims)
      .where(eq(agentClaims.userCodeHash, userCodeHash))
      .limit(1)
      .for('update');
    if (!claim) return { outcome: 'not_found' } as const;

    const identity = await lockIdentity(tx, claim.agentUserId);
    if (!identity || identity.revokedAt !== null) return { outcome: 'not_found' } as const;

    const claimer = await readClaimer(tx, input.claimerUserId);
    if (!claimer) return { outcome: 'not_found' } as const;

    const decision = decideClaimApproval(toClaimRecord(claim, identity.ownerUserId), input.action, claimer, input.now);

    if (decision.status === 'approved') {
      await tx
        .update(agentClaims)
        .set({ approvedAt: decision.approvedAt, ownerUserId: decision.ownerUserId })
        .where(eq(agentClaims.id, claim.id));
      await tx
        .update(agentIdentities)
        .set({ ownerUserId: decision.ownerUserId, claimedAt: decision.approvedAt })
        .where(and(eq(agentIdentities.userId, decision.agentUserId), isNull(agentIdentities.ownerUserId)));
      await tx
        .update(users)
        .set({ emailVerified: decision.approvedAt })
        .where(and(eq(users.id, decision.agentUserId), isNull(users.emailVerified)));
      return { outcome: 'approved', agentUserId: decision.agentUserId } as const;
    }

    if (decision.status === 'denied') {
      await tx.update(agentClaims).set({ deniedAt: decision.deniedAt }).where(eq(agentClaims.id, claim.id));
      return { outcome: 'denied', agentUserId: claim.agentUserId } as const;
    }

    return { outcome: 'refused', agentUserId: claim.agentUserId, decision } as const;
  });
}

// ---------------------------------------------------------------------------
// Poll (the agent, on the token endpoint)
// ---------------------------------------------------------------------------

export type PollAgentClaimResult =
  | { outcome: 'not_found' }
  | { outcome: 'authorization_pending' }
  | { outcome: 'slow_down' }
  | { outcome: 'expired_token' }
  | { outcome: 'access_denied' }
  /** Already answered `claimed` once — the route collapses this to invalid_grant. */
  | { outcome: 'already_redeemed' }
  /** Approved, but the agent is revoked, suspended or locked: burned, collapsed to invalid_grant. */
  | { outcome: 'agent_unavailable'; agentUserId: string }
  /** Claimed: who the agent's owner is. Nothing is minted — the agent keeps its own tokens (Decision 7). */
  | { outcome: 'ok'; agentUserId: string; owner: { id: string; name: string } };

/**
 * Poll the claim grant for the CALLING agent (the route proved `agentUserId`
 * from the agent's own access token). The agent's newest claim is locked FOR
 * UPDATE with its identity; `decideClaimPoll` decides. Like `pollDeviceToken`,
 * the throttle anchor advances only on an allowed poll. On `ok` the claim is
 * marked redeemed in the same transaction — the approval is reported once —
 * and the answer is the owner, never a credential: there is nothing here a
 * claim approver, a former owner or anyone but the agent could poll for.
 */
export async function pollAgentClaim(input: { agentUserId: string; now: Date }): Promise<PollAgentClaimResult> {
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select(CLAIM_COLUMNS)
      .from(agentClaims)
      .where(eq(agentClaims.agentUserId, input.agentUserId))
      .orderBy(desc(agentClaims.createdAt), desc(agentClaims.id))
      .limit(1)
      .for('update');
    if (!claim) return { outcome: 'not_found' } as const;

    const identity = await lockIdentity(tx, claim.agentUserId);
    if (!identity) return { outcome: 'not_found' } as const;

    const decision = decideClaimPoll(toClaimRecord(claim, identity.ownerUserId), input.now);

    if (decision.status === 'authorization_pending') {
      await tx.update(agentClaims).set({ lastPolledAt: input.now }).where(eq(agentClaims.id, claim.id));
    }
    if (decision.status !== 'ok') return { outcome: decision.status } as const;

    // Reported at most once: a second poll reads `redeemed`.
    await tx.update(agentClaims).set({ redeemedAt: input.now }).where(eq(agentClaims.id, claim.id));

    const signin = decideAgentSignin({
      account: { found: true, revokedAt: identity.revokedAt, suspendedAt: identity.suspendedAt, lockedUntil: identity.lockedUntil },
      now: input.now,
    });
    if (signin.status !== 'ok') return { outcome: 'agent_unavailable', agentUserId: claim.agentUserId } as const;

    const { agentUserId, ownerUserId } = decision.grant;
    const [ownerRow] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ownerUserId)).limit(1);
    const ownerName = ownerRow ? (await decryptUserRow({ name: ownerRow.name })).name : '';

    return { outcome: 'ok', agentUserId, owner: { id: ownerUserId, name: ownerName } } as const;
  });
}
