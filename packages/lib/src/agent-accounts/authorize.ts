/**
 * `authorize` — the account authority's whole intersection as ONE pure
 * function (L2·G2; ADR 0004 §4, §6; threat model §4):
 *
 *   authenticated caller ∩ delegation ∩ account permission ∩ page permission
 *   ∩ account-use binding ∩ kind ∩ canonical request ∩ origin pin ∩ approval
 *   ∩ epochs  →  an UNSIGNED `AgentAccountGrant`, or a typed refusal.
 *
 * Order and why:
 * 1. Entitlement first, and every failure of it is ONE refusal,
 *    `account_unavailable`: no row, a caller ceiling that excludes the drive,
 *    `decideAccountAccess` denying `use` (not the owner / not the acting human
 *    / not a drive member / no live session or delegation / not active), the
 *    run driving another agent page, or too little PAGE permission — an
 *    agent-page-owned account is used only by someone who can EDIT that page
 *    (its instructions steer the credential; view-only chatters cannot), and a
 *    user-owned account bound to a page needs at least view on it. A caller
 *    cannot tell "exists but not yours" from "does not exist".
 * 2. Only then kind (`api_key` only in this slice) and provisioning
 *    (`credentialVersion` 0 = the plane never committed material).
 * 3. The request: `canonicalizeRequest` (userinfo, wildcards, IP literals,
 *    reserved headers, traversal refused; the operation comes from the
 *    registry, never the caller) and `decideDestination` against the pin.
 * 4. Approval: `decideApproval` over restrictions, the delegation's scope and
 *    the policy; a `concrete` requirement is met only by an unconsumed,
 *    unexpired allow-once approval for THIS account and THIS digest (with
 *    step-up when the class needs it), which the adapter must consume by this
 *    grant's id before signing.
 * 5. The grant binds every principal, the epochs (credential and policy
 *    version) and `digestBindings` over `planeBindingsFor(row)` — the plane's
 *    independent check at resolve.
 * Pure: clock, ids and hash are inputs.
 */
import type { AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type {
  AgentAccountGrant,
  AgentPageId,
  ApprovalId,
  CallerCeiling,
  ConversationId,
  DelegationFact,
  DriveId,
  GrantId,
  GrantLimits,
  GrantPresenter,
  HashBytes,
  Nonce,
  RequestDigest,
  RunId,
  SessionId,
  UserId,
} from './grant';
import type { AccountApprovalPolicy, UsageCounters } from './approval';
import type { ApprovalSubject, CanonicalizeRefusal, CanonicalRequest, CanonicalRequestInput, OperationRegistry, ResourceRestrictions } from './canonical-request';
import type { DriveRoleOfHuman } from '../permissions/account-permissions';
import { decideAccountAccess } from '../permissions/decide-account-access';
import { canonicalizeRequest } from './canonicalize-request';
import { digestRequest } from './digest-request';
import { renderApprovalSubject } from './render-approval-subject';
import { decideApproval } from './decide-approval';
import { decideDestination, type DestinationVerdict } from './decide-destination';
import { planeBindingsFor } from './plane-bindings-for';
import { digestBindings } from './store/digest-bindings';

const GRANT_MAX_TTL_MS: GrantLimits['maxTtlMs'] = 900_000;

export type AuthorizeCaller = {
  /** The authenticated human making the request. */
  readonly actorUserId: UserId;
  /** Who the run acts as; equals `actorUserId` for a live chat. */
  readonly actingHumanUserId: UserId;
  /** Non-null for a live session; null = unattended, which needs a delegation. */
  readonly sessionId: SessionId | null;
  /** The agent page the run is driving; null for the global assistant. */
  readonly agentPageId: AgentPageId | null;
  readonly conversationId: ConversationId;
  readonly runId: RunId;
  readonly callerCeiling: CallerCeiling;
};

/** The repository-fetched facts around the row — data, never handles. */
export type AuthorizeFacts = {
  readonly humanDriveRole: DriveRoleOfHuman;
  /** The acting human's PageSpace permission on the agent page the run drives ('none' for the global assistant). */
  readonly agentPagePermission: 'edit' | 'view' | 'none';
  readonly agentBoundToAccount: boolean;
  /** Unrevoked `agent_account_bindings` page ids for this account. */
  readonly boundAgentPageIds: readonly AgentPageId[];
  readonly delegation: DelegationFact;
  readonly ceilingAdmitsAccount: boolean;
};

/** An allow-once approval row for the account, as the repository read it. */
export type ApprovalCandidate = {
  readonly approvalId: ApprovalId;
  readonly accountId: string;
  readonly requestDigest: RequestDigest;
  readonly expiresAt: number;
  readonly consumed: boolean;
  readonly steppedUp: boolean;
};

export type AuthorizeInput = {
  readonly caller: AuthorizeCaller;
  readonly account: AgentAccountRecord | null;
  readonly facts: AuthorizeFacts;
  /** Untrusted: what the tool layer asked to send. */
  readonly request: CanonicalRequestInput;
  readonly registry: OperationRegistry;
  readonly approvals: readonly ApprovalCandidate[];
  readonly usage: UsageCounters;
  readonly presenter: GrantPresenter;
  readonly now: number;
  readonly grantId: GrantId;
  readonly nonce: Nonce;
  /** Clamped to the 15-minute ceiling (ADR 0004 §2.3). */
  readonly ttlMs: number;
  /** SHA3-256. */
  readonly hash: HashBytes;
};

export type AuthorizeRefusal =
  | { readonly ok: false; readonly reason: 'account_unavailable' | 'kind_not_supported' | 'not_provisioned' }
  | { readonly ok: false; readonly reason: 'request_refused'; readonly rule: CanonicalizeRefusal }
  | { readonly ok: false; readonly reason: 'destination_denied'; readonly rule: Extract<DestinationVerdict, { readonly allow: false }>['reason'] }
  | { readonly ok: false; readonly reason: 'approval_required'; readonly digest: RequestDigest; readonly subject: ApprovalSubject; readonly stepUp: boolean }
  | { readonly ok: false; readonly reason: 'out_of_scope' | 'limits_exceeded' | 'class_never_always' | 'policy_expired' };

export type AuthorizeVerdict =
  | { readonly ok: true; readonly grant: AgentAccountGrant; readonly canonical: CanonicalRequest; readonly approvalToConsume: ApprovalId | null }
  | AuthorizeRefusal;

const UNAVAILABLE: AuthorizeRefusal = { ok: false, reason: 'account_unavailable' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored policy that is not even policy-shaped grants nothing by policy: every use asks. */
function policyOf(value: unknown): AccountApprovalPolicy | null {
  if (!isObject(value) || !isObject(value.scope)) return null;
  const { scope } = value;
  if (!Array.isArray(scope.origins) || !Array.isArray(scope.operations) || !Array.isArray(scope.resources)) return null;
  return value as unknown as AccountApprovalPolicy;
}

/** The PageSpace page-permission term of the intersection (exported so an approval is held to the same bar). */
export function pagePermissionSuffices(account: Pick<AgentAccountRecord, 'ownerKind' | 'ownerAgentPageId'>, caller: Pick<AuthorizeCaller, 'agentPageId'>, facts: Pick<AuthorizeFacts, 'agentPagePermission'>): boolean {
  if (account.ownerKind === 'agent_page') return caller.agentPageId === account.ownerAgentPageId && facts.agentPagePermission === 'edit';
  return caller.agentPageId === null || facts.agentPagePermission !== 'none';
}

export function authorize(input: AuthorizeInput): AuthorizeVerdict {
  const { caller, account, facts } = input;
  if (account === null) return UNAVAILABLE;

  const access = decideAccountAccess({
    facts: {
      accountId: account.id as AccountId,
      kind: account.kind,
      status: account.status,
      owner: account.ownerKind === 'user' ? { kind: 'user', userId: account.ownerUserId ?? '' } : { kind: 'agent_page', agentPageId: account.ownerAgentPageId ?? '', driveId: account.ownerDriveId ?? '' },
      accountDriveId: (account.ownerDriveId ?? null) as DriveId | null,
      actorUserId: caller.actorUserId,
      actingHumanUserId: caller.actingHumanUserId,
      humanDriveRole: facts.humanDriveRole,
      humanCanEditAgentPage: facts.agentPagePermission === 'edit',
      agentPageId: caller.agentPageId,
      agentBoundToAccount: facts.agentBoundToAccount,
      delegation: caller.sessionId === null ? facts.delegation : { kind: 'live_session' },
      sessionHttpEnabled: account.sessionHttpEnabled,
      callerCeiling: caller.callerCeiling,
      ceilingAdmitsAccount: facts.ceilingAdmitsAccount,
    },
  });
  if (!access.use || !pagePermissionSuffices(account, caller, facts)) return UNAVAILABLE;

  if (account.kind !== 'api_key') return { ok: false, reason: 'kind_not_supported' };
  if (account.credentialVersion < 1) return { ok: false, reason: 'not_provisioned' };

  const canonicalized = canonicalizeRequest({ request: input.request, providerSlug: account.providerSlug, registry: input.registry });
  if (!canonicalized.ok) return { ok: false, reason: 'request_refused', rule: canonicalized.reason };
  const canonical = canonicalized.canonical;
  const destination = decideDestination({ url: `${canonical.origin}${canonical.path}`, allowedOrigins: account.allowedOrigins as CanonicalRequest['origin'][], hop: 'initial' });
  if (!destination.allow) return { ok: false, reason: 'destination_denied', rule: destination.reason };

  const requestDigest = digestRequest({ canonical, hash: input.hash });
  const delegationScope = caller.sessionId === null && facts.delegation.kind === 'delegation' ? facts.delegation.scope : null;
  const requirement = decideApproval({
    operation: canonical.operation,
    restrictions: account.resourceRestrictions as ResourceRestrictions,
    delegationScope,
    policy: policyOf(account.approvalPolicy),
    requestDigest,
    origin: canonical.origin,
    resources: canonical.resources,
    now: input.now,
    usage: input.usage,
  });
  if (requirement.kind === 'refuse') return { ok: false, reason: requirement.reason };

  let approvalId: ApprovalId | 'policy' = 'policy';
  let approvalToConsume: ApprovalId | null = null;
  if (requirement.kind === 'concrete') {
    const approval = input.approvals.find(
      (candidate) =>
        candidate.accountId === account.id &&
        candidate.requestDigest === requestDigest &&
        !candidate.consumed &&
        candidate.expiresAt >= input.now &&
        (!requirement.stepUp || candidate.steppedUp),
    );
    if (approval === undefined) return { ok: false, reason: 'approval_required', digest: requestDigest, subject: renderApprovalSubject({ canonical }), stepUp: requirement.stepUp };
    approvalId = approval.approvalId;
    approvalToConsume = approval.approvalId;
  }

  const { bindings } = planeBindingsFor({ row: account, boundAgentPageIds: facts.boundAgentPageIds, hash: input.hash });
  const ttl = Math.min(Math.max(input.ttlMs, 0), GRANT_MAX_TTL_MS);
  const grant: AgentAccountGrant = {
    grantId: input.grantId,
    iss: 'pagespace-account-authority',
    aud: 'http-executor',
    tenantId: account.tenantId as TenantId,
    human: { userId: caller.actingHumanUserId, sessionId: caller.sessionId },
    delegationId: caller.sessionId === null && facts.delegation.kind === 'delegation' ? facts.delegation.delegationId : null,
    agentPageId: caller.agentPageId,
    conversationId: caller.conversationId,
    runId: caller.runId,
    sandbox: null,
    callerCeiling: caller.callerCeiling,
    accountId: account.id as AccountId,
    accountKind: account.kind,
    credentialVersion: account.credentialVersion as CredentialVersion,
    policyVersion: account.policyVersion as PolicyVersion,
    bindingDigest: digestBindings({ bindings, hash: input.hash }),
    operation: canonical.operation,
    requestDigest,
    sessionHttp: false,
    approvalId,
    iat: input.now,
    nbf: input.now,
    exp: input.now + ttl,
    nonce: input.nonce,
    presenter: input.presenter,
  };
  return { ok: true, grant, canonical, approvalToConsume };
}
