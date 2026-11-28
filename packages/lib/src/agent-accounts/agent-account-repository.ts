/**
 * The agent-account reference repository (L2·G2) — I/O only, no decision
 * logic. Reads and writes the MAIN-DB reference rows (`agent_accounts`,
 * `agent_account_bindings`, `agent_account_approvals`); it never sees material
 * and has nothing to read it with. What a row MEANS is decided elsewhere
 * (`authorize`, `toSafeAccount`, `decideAccountCreation`).
 *
 * Every list is bounded (`limit`), every state change that races is one
 * conditional statement: `setCredentialVersion` only moves 0 → n (the first
 * committed put), `consumeApproval` stamps an unconsumed, unexpired approval
 * with exactly one grant id, `markRevoked` bumps `policyVersion` so any grant
 * issued before it is `policy_epoch` at the verifier.
 *
 * Integration-tested against the real `:5433` Postgres
 * (`__tests__/agent-account-repository.integration.test.ts`).
 */
import type { db as defaultDb } from '@pagespace/db/db';
import { and, desc, eq, gt, gte, inArray, isNull, sql } from '@pagespace/db/operators';
import { agentAccountApprovals, agentAccountBindings, agentAccountDelegations, agentAccounts, type AccountId, type AccountOwnerRef, type AgentAccountRecord, type TenantId } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, ApprovalId, DelegationFact, DelegationId, GrantId, RequestDigest, UserId } from './grant';
import type { AccountApprovalPolicy, ApprovalScope } from './approval';
import type { AccountDraft } from './decide-account-creation';
import type { ApprovalCandidate } from './authorize';

export type AgentAccountDatabase = Pick<typeof defaultDb, 'insert' | 'select' | 'update' | 'delete'>;

/** An account list never needs more than this; the UI shows one agent's or one person's accounts. */
export const MAX_LISTED_ACCOUNTS = 100;
const MAX_OPEN_APPROVALS = 50;
const MAX_BOUND_PAGES = 100;
const MAX_DELEGATIONS = 50;

export type AccountBindingSummary = { readonly agentPageId: AgentPageId; readonly boundByUserId: string; readonly boundAt: number };
export type AccountDelegationSummary = {
  readonly id: DelegationId;
  readonly agentPageId: AgentPageId | null;
  readonly delegatedByUserId: string;
  readonly scope: unknown;
  readonly expiresAt: number;
  readonly createdAt: number;
};

type DelegationRow = typeof agentAccountDelegations.$inferSelect;

/** A delegation row as the fact `decideAccountAccess` and the verifier compare (ADR 0004 §4.4). */
function delegationFactOf(row: DelegationRow, now: number): DelegationFact {
  return {
    kind: 'delegation',
    delegationId: row.id as DelegationId,
    accountId: row.accountId as AccountId,
    agentPageId: (row.agentPageId ?? null) as AgentPageId | null,
    delegatedBy: row.delegatedByUserId as UserId,
    scope: row.scope as ApprovalScope,
    expired: row.expiresAt.getTime() <= now,
    revoked: row.revokedAt !== null,
  };
}

export type AgentAccountRepository = {
  readonly insert: (input: { readonly draft: AccountDraft; readonly owner: AccountOwnerRef; readonly tenantId: TenantId; readonly approvalPolicy: AccountApprovalPolicy | null }) => Promise<AgentAccountRecord>;
  /** The first committed put: 0 → version. `false` when the row is gone or already provisioned. */
  readonly setCredentialVersion: (input: { readonly id: string; readonly version: number }) => Promise<boolean>;
  readonly remove: (id: string) => Promise<void>;
  readonly find: (id: string) => Promise<AgentAccountRecord | null>;
  /** Which of these ids still have a reference row (the plane's orphan sweep, review MED-1). */
  readonly existingIds: (ids: readonly string[]) => Promise<readonly string[]>;
  readonly listForUser: (userId: string) => Promise<readonly AgentAccountRecord[]>;
  readonly listForAgentPage: (agentPageId: string) => Promise<readonly AgentAccountRecord[]>;
  /** Broker-denied from now on; bumps policyVersion. null when the row is gone. */
  readonly markRevoked: (input: { readonly id: string; readonly at: number }) => Promise<AgentAccountRecord | null>;
  readonly touchLastUsed: (input: { readonly id: string; readonly at: number }) => Promise<void>;
  readonly boundAgentPageIds: (accountId: string) => Promise<readonly AgentPageId[]>;
  /** Unrevoked bindings, for the account's settings. */
  readonly listBindings: (accountId: string) => Promise<readonly AccountBindingSummary[]>;
  /** Bind (or re-bind after a revoke — the key is `(accountId, agentPageId)`). Written only AFTER the plane accepted the rebind. */
  readonly upsertBinding: (input: { readonly accountId: string; readonly agentPageId: string; readonly boundByUserId: string; readonly at: number }) => Promise<void>;
  readonly revokeBinding: (input: { readonly accountId: string; readonly agentPageId: string; readonly at: number }) => Promise<void>;
  /** User-owned accounts of `userId` bound to this agent page (unrevoked). */
  readonly listBoundForUserOnPage: (input: { readonly agentPageId: string; readonly userId: string }) => Promise<readonly AgentAccountRecord[]>;
  /**
   * The scope fields a rebind changed, CAS on the policy version the edit started from. `null` = the row
   * moved meanwhile (or is gone); the plane already holds `nextPolicyVersion`, and the next edit re-reads it.
   */
  readonly updateScope: (input: {
    readonly id: string;
    readonly expectedPolicyVersion: number;
    readonly nextPolicyVersion: number;
    readonly allowedOrigins: readonly string[];
    readonly approvalPolicy: AccountApprovalPolicy | null;
    readonly at: number;
  }) => Promise<AgentAccountRecord | null>;
  /** The delegation a grant names, as a fact (the verifier's F7 input); null when absent. */
  readonly findDelegation: (input: { readonly delegationId: string; readonly now: number }) => Promise<DelegationFact | null>;
  /** The newest unexpired, unrevoked delegation from THIS human for THIS account on THIS agent page. */
  readonly activeDelegation: (input: { readonly accountId: string; readonly agentPageId: string | null; readonly delegatedByUserId: string; readonly now: number }) => Promise<DelegationFact | null>;
  /** Unexpired, unrevoked delegations of the account. */
  readonly listDelegations: (input: { readonly accountId: string; readonly now: number }) => Promise<readonly AccountDelegationSummary[]>;
  readonly insertDelegation: (input: { readonly accountId: string; readonly agentPageId: string | null; readonly delegatedByUserId: string; readonly scope: ApprovalScope; readonly expiresAt: number }) => Promise<DelegationId>;
  /** `false` when no unrevoked delegation with that id belongs to the account. */
  readonly revokeDelegation: (input: { readonly id: string; readonly accountId: string; readonly at: number }) => Promise<boolean>;
  readonly openApprovals: (input: { readonly accountId: string; readonly now: number }) => Promise<readonly ApprovalCandidate[]>;
  readonly insertApproval: (input: {
    readonly accountId: string;
    readonly requestDigest: RequestDigest;
    readonly approvedByUserId: string;
    readonly approvedViaSessionId: string;
    readonly stepUpChallengeId: string | null;
    readonly expiresAt: number;
  }) => Promise<ApprovalId>;
  /** Stamp exactly one grant onto an unconsumed, unexpired approval. `false` = another issuance won or it expired. */
  readonly consumeApproval: (input: { readonly approvalId: ApprovalId; readonly grantId: GrantId; readonly now: number }) => Promise<boolean>;
  /** The approval row as the verifier compares it (ADR 0004 F14); null when absent. */
  readonly findApproval: (approvalId: string) => Promise<{
    readonly approvalId: ApprovalId;
    readonly accountId: string;
    readonly requestDigest: RequestDigest;
    readonly consumedByGrantId: GrantId | null;
    readonly expiresAt: number;
  } | null>;
};

export function createAgentAccountRepository({ db }: { readonly db: AgentAccountDatabase }): AgentAccountRepository {
  return {
    async insert({ draft, owner, tenantId, approvalPolicy }) {
      const [row] = await db
        .insert(agentAccounts)
        .values({
          kind: draft.kind,
          ownerKind: owner.kind,
          ownerUserId: owner.kind === 'user' ? owner.userId : null,
          ownerAgentPageId: owner.kind === 'agent_page' ? owner.agentPageId : null,
          ownerDriveId: owner.kind === 'agent_page' ? owner.driveId : null,
          tenantId,
          name: draft.name,
          providerSlug: null,
          allowedOrigins: [...draft.allowedOrigins],
          approvalPolicy,
          acknowledgment: draft.acknowledgment,
        })
        .returning();
      return row!;
    },

    async setCredentialVersion({ id, version }) {
      const updated = await db
        .update(agentAccounts)
        .set({ credentialVersion: version, updatedAt: new Date() })
        .where(and(eq(agentAccounts.id, id), eq(agentAccounts.credentialVersion, 0)))
        .returning({ id: agentAccounts.id });
      return updated.length === 1;
    },

    async remove(id) {
      await db.delete(agentAccounts).where(eq(agentAccounts.id, id));
    },

    async find(id) {
      const rows = await db.select().from(agentAccounts).where(eq(agentAccounts.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async existingIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db.select({ id: agentAccounts.id }).from(agentAccounts).where(inArray(agentAccounts.id, [...ids])).limit(ids.length);
      return rows.map((row) => row.id);
    },

    async listForUser(userId) {
      return db.select().from(agentAccounts).where(eq(agentAccounts.ownerUserId, userId)).orderBy(desc(agentAccounts.createdAt)).limit(MAX_LISTED_ACCOUNTS);
    },

    async listForAgentPage(agentPageId) {
      return db.select().from(agentAccounts).where(eq(agentAccounts.ownerAgentPageId, agentPageId)).orderBy(desc(agentAccounts.createdAt)).limit(MAX_LISTED_ACCOUNTS);
    },

    async markRevoked({ id, at }) {
      const [row] = await db
        .update(agentAccounts)
        .set({
          status: 'revoked',
          revokedAt: sql`coalesce(${agentAccounts.revokedAt}, ${new Date(at)})`,
          upstreamRevocation: sql`coalesce(${agentAccounts.upstreamRevocation}, 'not_attempted')`,
          policyVersion: sql`${agentAccounts.policyVersion} + 1`,
          updatedAt: new Date(at),
        })
        .where(eq(agentAccounts.id, id))
        .returning();
      return row ?? null;
    },

    async touchLastUsed({ id, at }) {
      await db.update(agentAccounts).set({ lastUsedAt: new Date(at) }).where(eq(agentAccounts.id, id));
    },

    async boundAgentPageIds(accountId) {
      const rows = await db
        .select({ agentPageId: agentAccountBindings.agentPageId })
        .from(agentAccountBindings)
        .where(and(eq(agentAccountBindings.accountId, accountId), isNull(agentAccountBindings.revokedAt)))
        .limit(MAX_BOUND_PAGES);
      return rows.map((row) => row.agentPageId as AgentPageId);
    },

    async listBindings(accountId) {
      const rows = await db
        .select()
        .from(agentAccountBindings)
        .where(and(eq(agentAccountBindings.accountId, accountId), isNull(agentAccountBindings.revokedAt)))
        .orderBy(desc(agentAccountBindings.boundAt))
        .limit(MAX_BOUND_PAGES);
      return rows.map((row) => ({ agentPageId: row.agentPageId as AgentPageId, boundByUserId: row.boundByUserId, boundAt: row.boundAt.getTime() }));
    },

    async upsertBinding({ accountId, agentPageId, boundByUserId, at }) {
      await db
        .insert(agentAccountBindings)
        .values({ accountId, agentPageId, boundByUserId, boundAt: new Date(at) })
        .onConflictDoUpdate({ target: [agentAccountBindings.accountId, agentAccountBindings.agentPageId], set: { boundByUserId, boundAt: new Date(at), revokedAt: null } });
    },

    async revokeBinding({ accountId, agentPageId, at }) {
      await db
        .update(agentAccountBindings)
        .set({ revokedAt: new Date(at) })
        .where(and(eq(agentAccountBindings.accountId, accountId), eq(agentAccountBindings.agentPageId, agentPageId), isNull(agentAccountBindings.revokedAt)));
    },

    async listBoundForUserOnPage({ agentPageId, userId }) {
      const rows = await db
        .select({ account: agentAccounts })
        .from(agentAccountBindings)
        .innerJoin(agentAccounts, eq(agentAccounts.id, agentAccountBindings.accountId))
        .where(and(eq(agentAccountBindings.agentPageId, agentPageId), isNull(agentAccountBindings.revokedAt), eq(agentAccounts.ownerUserId, userId)))
        .orderBy(desc(agentAccounts.createdAt))
        .limit(MAX_LISTED_ACCOUNTS);
      return rows.map((row) => row.account);
    },

    async updateScope({ id, expectedPolicyVersion, nextPolicyVersion, allowedOrigins, approvalPolicy, at }) {
      const [row] = await db
        .update(agentAccounts)
        .set({ allowedOrigins: [...allowedOrigins], approvalPolicy, policyVersion: nextPolicyVersion, updatedAt: new Date(at) })
        .where(and(eq(agentAccounts.id, id), eq(agentAccounts.policyVersion, expectedPolicyVersion)))
        .returning();
      return row ?? null;
    },

    async findDelegation({ delegationId, now }) {
      const rows = await db.select().from(agentAccountDelegations).where(eq(agentAccountDelegations.id, delegationId)).limit(1);
      return rows[0] === undefined ? null : delegationFactOf(rows[0], now);
    },

    async activeDelegation({ accountId, agentPageId, delegatedByUserId, now }) {
      const rows = await db
        .select()
        .from(agentAccountDelegations)
        .where(
          and(
            eq(agentAccountDelegations.accountId, accountId),
            agentPageId === null ? isNull(agentAccountDelegations.agentPageId) : eq(agentAccountDelegations.agentPageId, agentPageId),
            eq(agentAccountDelegations.delegatedByUserId, delegatedByUserId),
            isNull(agentAccountDelegations.revokedAt),
            gt(agentAccountDelegations.expiresAt, new Date(now)),
          ),
        )
        .orderBy(desc(agentAccountDelegations.createdAt))
        .limit(1);
      return rows[0] === undefined ? null : delegationFactOf(rows[0], now);
    },

    async listDelegations({ accountId, now }) {
      const rows = await db
        .select()
        .from(agentAccountDelegations)
        .where(and(eq(agentAccountDelegations.accountId, accountId), isNull(agentAccountDelegations.revokedAt), gt(agentAccountDelegations.expiresAt, new Date(now))))
        .orderBy(desc(agentAccountDelegations.createdAt))
        .limit(MAX_DELEGATIONS);
      return rows.map((row) => ({
        id: row.id as DelegationId,
        agentPageId: (row.agentPageId ?? null) as AgentPageId | null,
        delegatedByUserId: row.delegatedByUserId,
        scope: row.scope,
        expiresAt: row.expiresAt.getTime(),
        createdAt: row.createdAt.getTime(),
      }));
    },

    async insertDelegation({ accountId, agentPageId, delegatedByUserId, scope, expiresAt }) {
      const [row] = await db
        .insert(agentAccountDelegations)
        .values({ accountId, agentPageId, delegatedByUserId, scope, expiresAt: new Date(expiresAt) })
        .returning({ id: agentAccountDelegations.id });
      return row!.id as DelegationId;
    },

    async revokeDelegation({ id, accountId, at }) {
      const updated = await db
        .update(agentAccountDelegations)
        .set({ revokedAt: new Date(at) })
        .where(and(eq(agentAccountDelegations.id, id), eq(agentAccountDelegations.accountId, accountId), isNull(agentAccountDelegations.revokedAt)))
        .returning({ id: agentAccountDelegations.id });
      return updated.length === 1;
    },

    async openApprovals({ accountId, now }) {
      const rows = await db
        .select()
        .from(agentAccountApprovals)
        .where(and(eq(agentAccountApprovals.accountId, accountId), eq(agentAccountApprovals.outcome, 'allow_once'), isNull(agentAccountApprovals.consumedAt), gte(agentAccountApprovals.expiresAt, new Date(now))))
        .orderBy(desc(agentAccountApprovals.createdAt))
        .limit(MAX_OPEN_APPROVALS);
      return rows.map((row) => ({
        approvalId: row.id as ApprovalId,
        accountId: row.accountId,
        requestDigest: row.requestDigest as RequestDigest,
        expiresAt: row.expiresAt.getTime(),
        consumed: row.consumedAt !== null,
        steppedUp: row.stepUpChallengeId !== null,
      }));
    },

    async insertApproval({ accountId, requestDigest, approvedByUserId, approvedViaSessionId, stepUpChallengeId, expiresAt }) {
      const [row] = await db
        .insert(agentAccountApprovals)
        .values({ accountId, requestDigest, outcome: 'allow_once', approvedByUserId, approvedViaSessionId, stepUpChallengeId, expiresAt: new Date(expiresAt) })
        .returning({ id: agentAccountApprovals.id });
      return row!.id as ApprovalId;
    },

    async consumeApproval({ approvalId, grantId, now }) {
      const updated = await db
        .update(agentAccountApprovals)
        .set({ consumedAt: new Date(now), consumedByGrantId: grantId })
        .where(and(eq(agentAccountApprovals.id, approvalId), isNull(agentAccountApprovals.consumedAt), gte(agentAccountApprovals.expiresAt, new Date(now))))
        .returning({ id: agentAccountApprovals.id });
      return updated.length === 1;
    },

    async findApproval(approvalId) {
      const rows = await db.select().from(agentAccountApprovals).where(eq(agentAccountApprovals.id, approvalId)).limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        approvalId: row.id as ApprovalId,
        accountId: row.accountId,
        requestDigest: row.requestDigest as RequestDigest,
        consumedByGrantId: (row.consumedByGrantId ?? null) as GrantId | null,
        expiresAt: row.expiresAt.getTime(),
      };
    },
  };
}
