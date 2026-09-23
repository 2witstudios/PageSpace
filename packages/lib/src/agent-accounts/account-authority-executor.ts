/**
 * `createAccountAuthority` — the account authority (L2·G2; ADR 0004 §7
 * `authority-executor.ts`): the one place the web process creates, lists,
 * revokes and USES agent accounts. I/O only: every decision is a pure module
 * (`decideAccountCreatePermission`, `decideAccountCreation`,
 * `decideAccountAccess`, `authorize`, `toSafeAccount`, `planeBindingsFor`);
 * this file fetches their facts and acts on their verdicts.
 *
 * It holds the grant-signing key (ADR 0005 §3.4 lists it as the web process's
 * one plane credential besides ingress) and NO store identity: material goes
 * to the plane once, at creation (`put`), and is never read back. Use is a
 * signed, one-use, ≤15-minute grant the plane verifies independently before
 * it resolves anything.
 *
 * Every refusal toward a model is a typed reason carrying no account facts;
 * an account the caller may not use is `account_unavailable`, exactly as a
 * missing one.
 */
import { randomBytes } from 'node:crypto';
import type { AccountOwnerRef, AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import type { AccountId } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, ApprovalId, DriveId, GrantId, HashBytes, Nonce, PresenterKeyId, RequestDigest, UserId } from './grant';
import type { AccountAccessLevel } from '../permissions/account-permissions';
import type { ApprovalSubject, CanonicalRequestInput, OperationRegistry } from './canonical-request';
import type { AuthorityKey } from './account-authority-key';
import type { AgentAccountRepository } from './agent-account-repository';
import type { AccountFactsRepository } from './account-facts-repository';
import type { PlaneClient } from './plane-client';
import type { PlanePutBody } from './executor/plane-wire';
import type { ReleasedResponse } from './filter-response';
import type { LoginOwnership } from './decide-acknowledgment';
import type { KeyPlacement, AccountCreationRefusal } from './decide-account-creation';
import type { AuthorizeCaller, AuthorizeRefusal } from './authorize';
import { decideAccountCreatePermission } from '../permissions/decide-account-create-permission';
import { decideAccountAccess } from '../permissions/decide-account-access';
import { decideAccountListView } from '../permissions/decide-account-list-view';
import { isDriveWithinCredentialScope } from '../agent-workspaces/credential-scope';
import { decideAccountCreation } from './decide-account-creation';
import { deriveTenantId } from './store/derive-tenant-id';
import { planeBindingsFor, ownerRefOf } from './plane-bindings-for';
import { toSafeAccount, type SafeAccount } from './to-safe-account';
import { authorize, pagePermissionSuffices } from './authorize';
import { signGrant } from './sign-grant';
import { renderApprovalSubject } from './render-approval-subject';

/** How long a human's allow-once decision stays redeemable. */
const APPROVAL_TTL_MS = 10 * 60_000;
/** A grant is minted for one immediate request. */
const GRANT_TTL_MS = 60_000;

export type AccountOwnerTarget = { readonly kind: 'user' } | { readonly kind: 'agent_page'; readonly agentPageId: string };

export type CreateAccountInput = {
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly ownership: LoginOwnership;
  readonly acknowledged: boolean;
  readonly apiKey: string;
  readonly placement: KeyPlacement;
  readonly allowGenericRequests: boolean;
};

export type CreateAccountResult =
  | { readonly ok: true; readonly account: SafeAccount }
  | AccountCreationRefusal
  | { readonly ok: false; readonly reason: 'forbidden' | 'owner_not_found' | 'plane_unavailable' | 'store_refused' };

export type AccountOperationResult =
  | { readonly ok: true; readonly response: ReleasedResponse }
  | Exclude<AuthorizeRefusal, { readonly reason: 'approval_required' }>
  | { readonly ok: false; readonly reason: 'approval_required'; readonly digest: RequestDigest; readonly subject: ApprovalSubject; readonly stepUp: boolean }
  | { readonly ok: false; readonly reason: 'refused' | 'upstream_unreachable' | 'outcome_unknown' | 'outcome_unrecorded' | 'audit_unavailable' | 'plane_unavailable' };

export type AccountAuthority = {
  readonly createAccount: (input: { readonly actorUserId: UserId; readonly owner: AccountOwnerTarget; readonly input: CreateAccountInput }) => Promise<CreateAccountResult>;
  /** `allowedDriveIds`: the caller's credential ceiling (`[]` = none); accounts outside it are not listed. */
  readonly listAccounts: (input: { readonly actorUserId: UserId; readonly owner: AccountOwnerTarget; readonly allowedDriveIds?: readonly string[] }) => Promise<readonly SafeAccount[] | null>;
  readonly revokeAccount: (input: { readonly actorUserId: UserId; readonly accountId: string }) => Promise<{ readonly ok: true; readonly account: SafeAccount } | { readonly ok: false; readonly reason: 'account_unavailable' | 'plane_unavailable' }>;
  readonly requestOperation: (input: { readonly caller: AuthorizeCaller; readonly accountId: string; readonly request: CanonicalRequestInput }) => Promise<AccountOperationResult>;
  readonly approveRequest: (input: {
    readonly actorUserId: UserId;
    readonly sessionId: string;
    readonly accountId: string;
    readonly requestDigest: string;
  }) => Promise<{ readonly ok: true; readonly approvalId: ApprovalId; readonly expiresAt: number } | { readonly ok: false; readonly reason: 'account_unavailable' }>;
};

export type AccountAuthorityDeps = {
  readonly accounts: AgentAccountRepository;
  readonly facts: AccountFactsRepository;
  readonly plane: PlaneClient;
  readonly authorityKey: AuthorityKey;
  readonly presenterKeyId: PresenterKeyId;
  readonly registry: OperationRegistry;
  /** SHA3-256. */
  readonly hash: HashBytes;
  readonly now: () => number;
  readonly newId?: () => string;
};

const defaultId = () => randomBytes(18).toString('base64url');

export function createAccountAuthority(deps: AccountAuthorityDeps): AccountAuthority {
  const newId = deps.newId ?? defaultId;

  /** `decideAccountAccess` for a human managing or approving from the account's own context (live session). */
  async function accessOf(row: AgentAccountRecord, actorUserId: UserId): Promise<AccountAccessLevel> {
    const agentPageId = (row.ownerAgentPageId ?? null) as AgentPageId | null;
    const role = row.ownerDriveId === null ? null : await deps.facts.driveRole({ driveId: row.ownerDriveId, userId: actorUserId });
    const permission = agentPageId === null ? 'none' : await deps.facts.pagePermission({ userId: actorUserId, pageId: agentPageId });
    const access = decideAccountAccess({
      facts: {
        accountId: row.id as AccountId,
        kind: row.kind,
        status: row.status,
        owner: ownerRefOf(row),
        accountDriveId: (row.ownerDriveId ?? null) as DriveId | null,
        actorUserId,
        actingHumanUserId: actorUserId,
        humanDriveRole: role,
        humanCanEditAgentPage: permission === 'edit',
        agentPageId,
        agentBoundToAccount: false,
        delegation: { kind: 'live_session' },
        sessionHttpEnabled: row.sessionHttpEnabled,
        callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
        ceilingAdmitsAccount: true,
      },
    });
    // `use` is held to the same page-permission bar as `authorize`, so an approval cannot be given by someone who could not make the call.
    return { ...access, use: access.use && pagePermissionSuffices(row, { agentPageId }, { agentPagePermission: permission }) };
  }

  async function ownerRefFor(owner: AccountOwnerTarget, actorUserId: UserId): Promise<AccountOwnerRef | null> {
    if (owner.kind === 'user') return { kind: 'user', userId: actorUserId };
    const driveId = await deps.facts.pageDrive(owner.agentPageId);
    return driveId === null ? null : { kind: 'agent_page', agentPageId: owner.agentPageId, driveId };
  }

  return {
    async createAccount({ actorUserId, owner, input }) {
      const ownerRef = await ownerRefFor(owner, actorUserId);
      if (ownerRef === null) return { ok: false, reason: 'owner_not_found' };
      const role = ownerRef.kind === 'agent_page' ? await deps.facts.driveRole({ driveId: ownerRef.driveId, userId: actorUserId }) : null;
      if (!decideAccountCreatePermission({ owner: ownerRef, actorUserId, humanDriveRole: role })) return { ok: false, reason: 'forbidden' };

      const verdict = decideAccountCreation({ kind: 'api_key', ...input, approver: actorUserId });
      if (!verdict.ok) return verdict;

      const tenantId = deriveTenantId({ owner: ownerRef });
      const row = await deps.accounts.insert({ draft: verdict.draft, owner: ownerRef, tenantId, approvalPolicy: verdict.draft.approvalPolicy });
      const { scope, bindings } = planeBindingsFor({ row, boundAgentPageIds: [], hash: deps.hash });
      const consenters: PlanePutBody['consenters'] = ownerRef.kind === 'user' ? { kind: 'owner' } : { kind: 'pinned', userIds: [...(await deps.facts.driveConsenters(ownerRef.driveId))] };

      const put = await deps.plane.put({
        ref: { tenantId, accountId: row.id, kind: 'api_key' },
        material: { kind: 'api_key', material: { value: input.apiKey, placement: verdict.draft.placement } },
        bindings: bindings as unknown as Record<string, unknown>,
        scope: scope as unknown as Record<string, unknown>,
        consenters,
      });
      if (!put.ok) {
        // A definite refusal stored nothing, so the row goes. Any uncertain failure (the plane was unreachable
        // or timed out, the write could not be verified) may have left material in the vault: the row STAYS at
        // credentialVersion 0 — listed as not ready, unusable, revocable — so nothing is orphaned (review MED-2).
        const definite = put.reason === 'kind_mismatch' || put.reason === 'consenters_invalid' || put.reason === 'identity_refused' || put.reason === 'version_conflict';
        if (definite) await deps.accounts.remove(row.id);
        return { ok: false, reason: definite ? 'store_refused' : 'plane_unavailable' };
      }
      await deps.accounts.setCredentialVersion({ id: row.id, version: put.version });
      const stored = await deps.accounts.find(row.id);
      return stored === null ? { ok: false, reason: 'store_refused' } : { ok: true, account: toSafeAccount({ row: stored }) };
    },

    async listAccounts({ actorUserId, owner, allowedDriveIds = [] }) {
      const withinCeiling = (row: AgentAccountRecord) => isDriveWithinCredentialScope(allowedDriveIds, row.ownerDriveId);
      if (owner.kind === 'user') return (await deps.accounts.listForUser(actorUserId)).filter(withinCeiling).map((row) => toSafeAccount({ row }));
      // Decided from the caller's standing on the page BEFORE any row is read, so a refusal says nothing about
      // whether the page has accounts (review LOW-2).
      const driveId = await deps.facts.pageDrive(owner.agentPageId);
      if (driveId === null) return null;
      const humanDriveRole = await deps.facts.driveRole({ driveId, userId: actorUserId });
      const pagePermission = await deps.facts.pagePermission({ userId: actorUserId, pageId: owner.agentPageId });
      if (!decideAccountListView({ humanDriveRole, pagePermission })) return null;
      // An account minted in the page's previous drive stays bound to that drive (its tenant is immutable): not listed here.
      return (await deps.accounts.listForAgentPage(owner.agentPageId)).filter((row) => row.ownerDriveId === driveId && withinCeiling(row)).map((row) => toSafeAccount({ row }));
    },

    async revokeAccount({ actorUserId, accountId }) {
      const row = await deps.accounts.find(accountId);
      if (row === null || !(await accessOf(row, actorUserId)).manage) return { ok: false, reason: 'account_unavailable' };
      const ref = { tenantId: row.tenantId, accountId: row.id, kind: 'api_key' as const };
      // A not-ready account (its first put never committed) may still have left material in the vault with no
      // plane record to revoke: erase it outright instead (second review MED-1).
      const done = row.credentialVersion === 0 ? await deps.plane.delete({ ref }) : await deps.plane.revoke({ ref });
      if (!done.ok && done.reason !== 'not_found') return { ok: false, reason: 'plane_unavailable' };
      const marked = await deps.accounts.markRevoked({ id: row.id, at: deps.now() });
      return marked === null ? { ok: false, reason: 'account_unavailable' } : { ok: true, account: toSafeAccount({ row: marked }) };
    },

    async requestOperation({ caller, accountId, request }) {
      const now = deps.now();
      const row = await deps.accounts.find(accountId);
      const humanDriveRole = row?.ownerDriveId ? await deps.facts.driveRole({ driveId: row.ownerDriveId, userId: caller.actingHumanUserId }) : null;
      const agentPagePermission = caller.agentPageId === null ? 'none' : await deps.facts.pagePermission({ userId: caller.actingHumanUserId, pageId: caller.agentPageId });
      const boundAgentPageIds = row === null ? [] : await deps.accounts.boundAgentPageIds(row.id);
      const verdict = authorize({
        caller,
        account: row,
        facts: {
          humanDriveRole,
          agentPagePermission,
          agentBoundToAccount: caller.agentPageId !== null && boundAgentPageIds.includes(caller.agentPageId),
          boundAgentPageIds,
          delegation: { kind: 'none' },
          ceilingAdmitsAccount: isDriveWithinCredentialScope(caller.callerCeiling.allowedDriveIds, row?.ownerDriveId ?? null),
        },
        request,
        registry: deps.registry,
        approvals: row === null ? [] : await deps.accounts.openApprovals({ accountId: row.id, now }),
        usage: { usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 },
        presenter: { keyId: deps.presenterKeyId, channel: 'http-executor' },
        now,
        grantId: newId() as GrantId,
        nonce: newId() as Nonce,
        ttlMs: GRANT_TTL_MS,
        hash: deps.hash,
      });
      if (!verdict.ok) return verdict;

      if (verdict.approvalToConsume !== null) {
        // The approval is spent BY this grant (ADR 0004 §4.3): the verifier accepts it only for this grantId.
        const consumed = await deps.accounts.consumeApproval({ approvalId: verdict.approvalToConsume, grantId: verdict.grant.grantId, now });
        if (!consumed) return { ok: false, reason: 'approval_required', digest: verdict.grant.requestDigest, subject: renderApprovalSubject({ canonical: verdict.canonical }), stepUp: verdict.approvalStepUp };
      }

      const signature = signGrant({ grant: verdict.grant, key: deps.authorityKey });
      const executed = await deps.plane.execute({
        grant: verdict.grant,
        signature,
        request: { method: request.method, url: request.url, headers: { ...request.headers }, bodyBase64: Buffer.from(request.body).toString('base64') },
        run: { human: verdict.grant.human, agentPageId: verdict.grant.agentPageId, conversationId: verdict.grant.conversationId, runId: verdict.grant.runId },
      });
      return executed;
    },

    async approveRequest({ actorUserId, sessionId, accountId, requestDigest }) {
      const row = await deps.accounts.find(accountId);
      if (row === null || !(await accessOf(row, actorUserId)).use) return { ok: false, reason: 'account_unavailable' };
      const expiresAt = deps.now() + APPROVAL_TTL_MS;
      const approvalId = await deps.accounts.insertApproval({ accountId: row.id, requestDigest: requestDigest as RequestDigest, approvedByUserId: actorUserId, approvedViaSessionId: sessionId, stepUpChallengeId: null, expiresAt });
      return { ok: true, approvalId, expiresAt };
    },
  };
}

