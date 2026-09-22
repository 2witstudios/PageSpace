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
import { and, desc, eq, gte, inArray, isNull, sql } from '@pagespace/db/operators';
import { agentAccountApprovals, agentAccountBindings, agentAccounts, type AccountOwnerRef, type AgentAccountRecord, type TenantId } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, ApprovalId, GrantId, RequestDigest } from './grant';
import type { AccountApprovalPolicy } from './approval';
import type { AccountDraft } from './decide-account-creation';
import type { ApprovalCandidate } from './authorize';

export type AgentAccountDatabase = Pick<typeof defaultDb, 'insert' | 'select' | 'update' | 'delete'>;

/** An account list never needs more than this; the UI shows one agent's or one person's accounts. */
export const MAX_LISTED_ACCOUNTS = 100;
const MAX_OPEN_APPROVALS = 50;
const MAX_BOUND_PAGES = 100;

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
