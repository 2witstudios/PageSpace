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
 *
 * Changing what an account may do (slice 2: its sites and standing policy, the
 * agent pages a user-owned account is attached to) is a `rebind` of the
 * plane's bindings, then the main-DB row. The plane is the judge of
 * narrowing: an edit that only narrows needs the `grant` permission alone; one
 * that widens also needs a fresh step-up, which this authority turns into an
 * `OwnerConsent` signed under the consent key — and the plane accepts it only
 * from a consenter it pinned. Every rebind starts from the plane's own stored
 * policy version (`describe`), so a rebind that landed while its response was
 * lost is never re-applied over itself. Delegations (unattended use) are
 * main-DB rows the plane verifier reads by id; creating one is widening, so
 * it needs step-up too.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AccountOwnerRef, AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import type { AccountId } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, ApprovalId, DriveId, GrantId, HashBytes, Nonce, PresenterKeyId, RequestDigest, UserId } from './grant';
import type { AccountAccessLevel } from '../permissions/account-permissions';
import type { ApprovalSubject, CanonicalRequestInput, OperationRegistry } from './canonical-request';
import type { AuthorityKey } from './account-authority-key';
import type { AgentAccountRepository } from './agent-account-repository';
import type { AccountFactsRepository } from './account-facts-repository';
import type { PlaneClient } from './plane-client';
import type { PlaneHttpKind, PlanePutBody } from './executor/plane-wire';
import type { AccountBindingSummary, AccountDelegationSummary } from './agent-account-repository';
import type { ConsentId, DelegationFact, DelegationId } from './grant';
import type { AccountApprovalPolicy, UsageCounters } from './approval';
import type { PlaneScope } from './store/store-adapter';
import { decideAccountEdit, autoApproveOf, type AccountEdit, type AccountEditRefusal } from './decide-account-edit';
import { isScopeNarrowing } from './store/is-scope-narrowing';
import { mintOwnerConsent } from './mint-owner-consent';
import { GENERIC_REQUEST_OPERATION, type CreatableAccountKind } from './decide-account-creation';
import { GOOGLE_ORIGINS } from './registry/google-operations';
import { decideGoogleEnrollment, type GoogleEnrollmentInput, type GoogleEnrollmentVerdict } from './oauth/google-enrollment';
import type { PlaneOAuthExchangeResult, PlaneSshHostKeyResult } from './executor/plane-wire';
import type { SshExecutionResult } from './executor/decide-ssh-result';
import { authorizeSsh } from './authorize';
import { decideSshAccount, type SshAccountInput, type SshAccountVerdict } from './ssh/decide-ssh-account';
import { normalizeSshTarget, sshTargetOf } from './ssh/ssh-command';
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
import type { AccessActor } from '../permissions/access-actor';
import { signGrant } from './sign-grant';
import { renderApprovalSubject } from './render-approval-subject';

/** How long a human's allow-once decision stays redeemable. */
const APPROVAL_TTL_MS = 10 * 60_000;
/** A grant is minted for one immediate request. */
const GRANT_TTL_MS = 60_000;
/** The longest an unattended-use delegation may run before a human renews it. */
export const MAX_DELEGATION_MS = 90 * 24 * 60 * 60_000;
const MIN_DELEGATION_MS = 5 * 60_000;
/** An account attached to more agents than this would no longer fit the plane's bound-page read. */
export const MAX_BOUND_AGENT_PAGES = 50;
const ZERO_USAGE: UsageCounters = { usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 };

export type AccountOwnerTarget = { readonly kind: 'user' } | { readonly kind: 'agent_page'; readonly agentPageId: string };

export type CreateAccountInput = {
  /** Defaults to `api_key`. A `bearer` token is always sent as `Authorization: Bearer <token>`. */
  readonly kind?: CreatableAccountKind;
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

/** A step-up the route consumed for this account change; its id is signed into the consent. */
export type StepUpProof = { readonly challengeId: string };

/** What the person who manages an account sees and edits (never material, never versions). */
export type AccountSettings = {
  readonly account: SafeAccount;
  /** The standing "allow without asking" policy, or null when every request asks. */
  readonly autoApprove: { readonly enabled: true; readonly maxUsesPerHour: number; readonly until: number | null; readonly classes: readonly ('read' | 'write')[] } | null;
  /** Uses in the policy's rolling hour, from the plane's ledger; null when it could not be read. */
  readonly usesThisHour: number | null;
  readonly bindings: readonly AccountBindingSummary[];
  readonly delegations: readonly AccountDelegationSummary[];
  /** Only the owner of a user-owned account can attach it to agents. */
  readonly canBind: boolean;
};

export type AccountChangeRefusal =
  | AccountEditRefusal
  | {
      readonly ok: false;
      readonly reason:
        | 'account_unavailable'
        /** The change widens what the account may do: retry with a fresh step-up. */
        | 'step_up_required'
        /** No consent key is configured: nothing can be widened. */
        | 'consent_unavailable'
        /** The plane did not pin this human as a consenter for the account. */
        | 'not_a_consenter'
        /** Someone else changed the account meanwhile: reload and retry. */
        | 'conflict'
        | 'plane_unavailable'
        | 'store_refused'
        | 'page_unavailable'
        /** Unattended runs cannot answer approval prompts: they need "allow without asking" on. */
        | 'auto_approve_required'
        | 'expiry_invalid'
        /** The account is attached to as many agents as it can be. */
        | 'bindings_full'
        | 'delegation_unavailable';
    };

export type AccountChangeResult = { readonly ok: true; readonly settings: AccountSettings } | AccountChangeRefusal;

export type OAuthEnrollmentRefusal =
  | Extract<GoogleEnrollmentVerdict, { readonly ok: false }>
  | { readonly ok: false; readonly reason: 'forbidden' | 'owner_not_found' | 'plane_unavailable' | 'store_refused' }
  | { readonly ok: false; readonly reason: 'provider_refused'; readonly detail: Extract<PlaneOAuthExchangeResult, { readonly ok: false }>['reason'] };

export type SshCommandResult =
  | SshExecutionResult
  | Exclude<AuthorizeRefusal, { readonly reason: 'approval_required' }>
  | { readonly ok: false; readonly reason: 'approval_required'; readonly digest: RequestDigest; readonly subject: ApprovalSubject; readonly stepUp: boolean }
  | { readonly ok: false; readonly reason: 'plane_unavailable' };

export type AccountAuthority = {
  readonly createAccount: (input: { readonly actor: AccessActor; readonly owner: AccountOwnerTarget; readonly input: CreateAccountInput }) => Promise<CreateAccountResult>;
  /** `allowedDriveIds`: the caller's credential ceiling (`[]` = none); accounts outside it are not listed. */
  readonly listAccounts: (input: { readonly actor: AccessActor; readonly owner: AccountOwnerTarget; readonly allowedDriveIds?: readonly string[] }) => Promise<readonly SafeAccount[] | null>;
  readonly revokeAccount: (input: { readonly actor: AccessActor; readonly accountId: string }) => Promise<{ readonly ok: true; readonly account: SafeAccount } | { readonly ok: false; readonly reason: 'account_unavailable' | 'plane_unavailable' }>;
  /** `actor`: the acting human's credential; it must be `caller.actingHumanUserId`. */
  readonly requestOperation: (input: { readonly actor: AccessActor; readonly caller: AuthorizeCaller; readonly accountId: string; readonly request: CanonicalRequestInput }) => Promise<AccountOperationResult>;
  readonly approveRequest: (input: {
    readonly actor: AccessActor;
    readonly sessionId: string;
    readonly accountId: string;
    readonly requestDigest: string;
    /** A consumed step-up bound to this exact request — required for a `privilege` operation (e.g. sharing a Drive file). */
    readonly stepUp?: StepUpProof | null;
  }) => Promise<{ readonly ok: true; readonly approvalId: ApprovalId; readonly expiresAt: number } | { readonly ok: false; readonly reason: 'account_unavailable' }>;
  /** The account's permissions as its manager sees them; `account_unavailable` for anyone without `manage`. */
  readonly describeAccount: (input: { readonly actor: AccessActor; readonly accountId: string }) => Promise<AccountChangeResult>;
  readonly updateAccount: (input: { readonly actor: AccessActor; readonly accountId: string; readonly edit: AccountEdit; readonly stepUp: StepUpProof | null }) => Promise<AccountChangeResult>;
  /** Attach a user-owned account to an agent page the owner can edit. Always widening: needs step-up. */
  readonly bindAccount: (input: { readonly actor: AccessActor; readonly accountId: string; readonly agentPageId: string; readonly stepUp: StepUpProof | null }) => Promise<AccountChangeResult>;
  readonly unbindAccount: (input: { readonly actor: AccessActor; readonly accountId: string; readonly agentPageId: string }) => Promise<AccountChangeResult>;
  /** Let unattended runs (schedules, workflows) the actor starts on this agent page use the account, until `expiresAt`. */
  readonly createDelegation: (input: { readonly actor: AccessActor; readonly accountId: string; readonly agentPageId: string; readonly expiresAt: number; readonly stepUp: StepUpProof | null }) => Promise<AccountChangeResult>;
  readonly revokeDelegation: (input: { readonly actor: AccessActor; readonly accountId: string; readonly delegationId: string }) => Promise<AccountChangeResult>;
  /** The host key a server presents, for the person to confirm before an SSH account is created. */
  readonly probeSshHost: (input: { readonly actor: AccessActor; readonly owner: AccountOwnerTarget; readonly host: string; readonly port: number | null }) => Promise<
    | { readonly ok: true; readonly target: string; readonly fingerprint: string; readonly algorithm: string }
    | { readonly ok: false; readonly reason: 'forbidden' | 'owner_not_found' | 'host_invalid' | 'port_invalid' | 'plane_unavailable' }
    | Extract<PlaneSshHostKeyResult, { readonly ok: false }>
  >;
  /** Create an SSH account: the plane generates the key and pins the confirmed host key; only the PUBLIC key comes back, to install on the server. */
  readonly createSshAccount: (input: { readonly actor: AccessActor; readonly owner: AccountOwnerTarget; readonly input: SshAccountInput }) => Promise<
    | { readonly ok: true; readonly account: SafeAccount; readonly publicKey: string }
    | Extract<SshAccountVerdict, { readonly ok: false }>
    | { readonly ok: false; readonly reason: 'forbidden' | 'owner_not_found' | 'plane_unavailable' | 'store_refused' }
  >;
  /** `actor`: the acting human's credential; it must be `caller.actingHumanUserId`. */
  readonly requestSshCommand: (input: { readonly actor: AccessActor; readonly caller: AuthorizeCaller; readonly accountId: string; readonly command: string; readonly stdin: string }) => Promise<SshCommandResult>;
  /**
   * Before sending a person to Google: may they connect an account for this owner, and what to ask for.
   * Nothing is written. The same checks run again at `completeOAuthEnrollment`.
   */
  readonly prepareOAuthEnrollment: (input: { readonly actor: AccessActor; readonly owner: AccountOwnerTarget; readonly input: GoogleEnrollmentInput }) => Promise<{ readonly ok: true; readonly requestedScopes: readonly string[] } | OAuthEnrollmentRefusal>;
  /** After Google redirected back: the plane exchanges the code and stores the tokens; the row records the version and the account's email. */
  readonly completeOAuthEnrollment: (input: {
    readonly actor: AccessActor;
    readonly owner: AccountOwnerTarget;
    readonly input: GoogleEnrollmentInput;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }) => Promise<{ readonly ok: true; readonly account: SafeAccount; readonly email: string } | OAuthEnrollmentRefusal>;
};

export type AccountAuthorityDeps = {
  readonly accounts: AgentAccountRepository;
  readonly facts: AccountFactsRepository;
  readonly plane: PlaneClient;
  readonly authorityKey: AuthorityKey;
  readonly presenterKeyId: PresenterKeyId;
  readonly registry: OperationRegistry;
  /** The step-up consent key (its public half is the plane's `AGENT_ACCOUNTS_CONSENT_PUBLIC_KEY`); null = nothing can be widened. */
  readonly consentKey: { readonly sign: (message: Uint8Array) => Uint8Array } | null;
  /**
   * Serializes changes to ONE account across every web replica (a main-DB advisory lock): describe →
   * rebind → record must not interleave, or the plane and the row end at different versions and every
   * grant fails. `busy` when another change holds it.
   */
  /** The origins each provider's accounts may be pinned to (default: Google's APIs); an edit never adds another. */
  readonly providerOrigins?: Readonly<Record<string, readonly string[]>>;
  readonly lockAccount: <T>(accountId: string, fn: () => Promise<T>) => Promise<{ readonly acquired: true; readonly result: T } | { readonly acquired: false }>;
  /** SHA3-256. */
  readonly hash: HashBytes;
  /** SHA-256 (an SSH command's body digest); defaults to node:crypto. */
  readonly sha256?: HashBytes;
  readonly now: () => number;
  readonly newId?: () => string;
};

/** An SSH account's pinned target, or null for any other account. */
const sshTargetOfRow = (row: AgentAccountRecord) => (row.kind === 'ssh_key' && row.allowedOrigins.length === 1 ? (sshTargetOf(row.allowedOrigins[0]!)?.target ?? null) : null);

const refused = (reason: Extract<AccountChangeRefusal, { readonly reason: string }>['reason']): AccountChangeRefusal => ({ ok: false, reason }) as AccountChangeRefusal;

function refOf(row: Pick<AgentAccountRecord, 'tenantId' | 'id' | 'kind'>): { tenantId: string; accountId: string; kind: PlaneHttpKind } {
  return { tenantId: row.tenantId, accountId: row.id, kind: row.kind as PlaneHttpKind };
}

const defaultId = () => randomBytes(18).toString('base64url');

export function createAccountAuthority(input: AccountAuthorityDeps): AccountAuthority {
  const deps = { ...input, sha256: input.sha256 ?? ((bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')) };
  const newId = deps.newId ?? defaultId;

  /** `decideAccountAccess` for a human managing or approving from the account's own context (live session). */
  async function accessOf(row: AgentAccountRecord, actor: AccessActor): Promise<AccountAccessLevel> {
    const actorUserId = actor.userId as UserId;
    const agentPageId = (row.ownerAgentPageId ?? null) as AgentPageId | null;
    const role = row.ownerDriveId === null ? null : await deps.facts.driveRole({ driveId: row.ownerDriveId, actor });
    const permission = agentPageId === null ? 'none' : await deps.facts.pagePermission({ actor, pageId: agentPageId });
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

  async function settingsOf(row: AgentAccountRecord): Promise<AccountSettings> {
    const now = deps.now();
    const [bindings, delegations, usage] = await Promise.all([
      deps.accounts.listBindings(row.id),
      deps.accounts.listDelegations({ accountId: row.id, now }),
      row.approvalPolicy === null || row.status !== 'active' ? Promise.resolve(null) : deps.plane.usage({ ref: refOf(row) }),
    ]);
    return {
      account: toSafeAccount({ row }),
      autoApprove: autoApproveOf(row.approvalPolicy),
      usesThisHour: usage !== null && usage.ok ? usage.usesThisHour : null,
      bindings,
      delegations,
      canBind: row.ownerKind === 'user',
    };
  }

  /** The row, when the actor may change it (`grant`) and it is live; null otherwise. */
  async function changeable(accountId: string, actor: AccessActor): Promise<AgentAccountRecord | null> {
    const row = await deps.accounts.find(accountId);
    if (row === null || row.status !== 'active' || row.credentialVersion < 1) return null;
    return (await accessOf(row, actor)).grant ? row : null;
  }

  /**
   * Push the account's next scope to the plane, then report what the DB must record. `next` is what
   * changes on the row; `boundAgentPageIds` the unrevoked bindings the plane must hold.
   */
  async function rebindTo({
    row,
    next,
    boundAgentPageIds,
    actor,
    stepUp,
  }: {
    readonly row: AgentAccountRecord;
    readonly next: { readonly allowedOrigins: readonly string[]; readonly approvalPolicy: AccountApprovalPolicy | null };
    readonly boundAgentPageIds: readonly AgentPageId[];
    readonly actor: AccessActor;
    readonly stepUp: StepUpProof | null;
  }): Promise<{ readonly ok: true; readonly policyVersion: number } | AccountChangeRefusal> {
    const currentBound = await deps.accounts.boundAgentPageIds(row.id);
    const current = planeBindingsFor({ row, boundAgentPageIds: currentBound, hash: deps.hash }).scope;
    const candidate = planeBindingsFor({ row: { ...row, ...next, allowedOrigins: [...next.allowedOrigins] }, boundAgentPageIds, hash: deps.hash }).scope;
    const widens = !isScopeNarrowing({ stored: current, next: candidate });
    if (widens && stepUp === null) return refused('step_up_required');
    if (stepUp !== null && deps.consentKey === null) return refused('consent_unavailable');

    const ref = refOf(row);
    const described = await deps.plane.describe({ ref });
    if (!described.ok) return refused(described.reason === 'plane_unavailable' || described.reason === 'store_unavailable' ? 'plane_unavailable' : 'account_unavailable');
    if (described.revoked) return refused('account_unavailable');
    // Past both sides' versions: a rebind whose response was lost is never re-applied over itself.
    const policyVersion = Math.max(row.policyVersion, described.policyVersion) + 1;
    const { scope, bindings } = planeBindingsFor({
      row: { ...row, allowedOrigins: [...next.allowedOrigins], approvalPolicy: next.approvalPolicy, policyVersion },
      boundAgentPageIds,
      hash: deps.hash,
    });
    const consent =
      stepUp === null || deps.consentKey === null
        ? null
        : mintOwnerConsent({
            consentId: newId() as ConsentId,
            consentingUserId: actor.userId as UserId,
            stepUpChallengeId: stepUp.challengeId,
            ref: ref as never,
            bindings,
            consenters: described.consenters,
            issuedAt: deps.now(),
            sign: deps.consentKey.sign,
            hash: deps.hash,
          });
    const rebound = await deps.plane.rebind({
      ref,
      expectedVersion: described.policyVersion,
      bindings: bindings as unknown as Record<string, unknown>,
      scope: scope as unknown as Record<string, unknown>,
      consenters: described.consenters as PlanePutBody['consenters'],
      consent: consent as never,
    });
    if (rebound.ok) return { ok: true, policyVersion };
    switch (rebound.reason) {
      case 'consent_required':
        return refused(stepUp === null ? 'step_up_required' : 'not_a_consenter');
      case 'consent_invalid':
        return refused('not_a_consenter');
      case 'version_conflict':
        return refused('conflict');
      case 'revoked':
      case 'not_found':
        return refused('account_unavailable');
      case 'immutable_binding_changed':
      case 'identity_refused':
        return refused('store_refused');
      default:
        return refused('plane_unavailable');
    }
  }

  /** Record a landed rebind on the row (CAS from the version the edit started at). */
  async function recordScope(row: AgentAccountRecord, next: { readonly allowedOrigins: readonly string[]; readonly approvalPolicy: AccountApprovalPolicy | null }, policyVersion: number): Promise<AgentAccountRecord | null> {
    return deps.accounts.updateScope({ id: row.id, expectedPolicyVersion: row.policyVersion, nextPolicyVersion: policyVersion, allowedOrigins: next.allowedOrigins, approvalPolicy: next.approvalPolicy, at: deps.now() });
  }

  const providerOriginsMap: Readonly<Record<string, readonly string[]>> = deps.providerOrigins ?? { google: GOOGLE_ORIGINS };
  const providerOriginsOf = (row: AgentAccountRecord) => (row.providerSlug === null ? null : (providerOriginsMap[row.providerSlug] ?? []));

  /** Run one account change under the account's lock, re-reading the row inside it. */
  async function serialized(accountId: string, actor: AccessActor, change: (row: AgentAccountRecord) => Promise<AccountChangeResult>): Promise<AccountChangeResult> {
    const locked = await deps.lockAccount(accountId, async () => {
      const row = await changeable(accountId, actor);
      return row === null ? refused('account_unavailable') : change(row);
    });
    return locked.acquired ? locked.result : refused('conflict');
  }

  const unchangedScope = (row: AgentAccountRecord) => ({ allowedOrigins: row.allowedOrigins, approvalPolicy: (row.approvalPolicy ?? null) as AccountApprovalPolicy | null });

  /** The owner reference, when the actor may create an account for it. */
  async function creatableOwner(actor: AccessActor, owner: AccountOwnerTarget): Promise<{ readonly ok: true; readonly ownerRef: AccountOwnerRef } | { readonly ok: false; readonly reason: 'forbidden' | 'owner_not_found' }> {
    const ownerRef = await ownerRefFor(owner, actor.userId as UserId);
    if (ownerRef === null) return { ok: false, reason: 'owner_not_found' };
    const role = ownerRef.kind === 'agent_page' ? await deps.facts.driveRole({ driveId: ownerRef.driveId, actor }) : null;
    return decideAccountCreatePermission({ owner: ownerRef, actorUserId: actor.userId as UserId, humanDriveRole: role }) ? { ok: true, ownerRef } : { ok: false, reason: 'forbidden' };
  }

  return {
    async createAccount({ actor, owner, input }) {
      const actorUserId = actor.userId as UserId;
      const ownerRef = await ownerRefFor(owner, actorUserId);
      if (ownerRef === null) return { ok: false, reason: 'owner_not_found' };
      const role = ownerRef.kind === 'agent_page' ? await deps.facts.driveRole({ driveId: ownerRef.driveId, actor }) : null;
      if (!decideAccountCreatePermission({ owner: ownerRef, actorUserId, humanDriveRole: role })) return { ok: false, reason: 'forbidden' };

      const verdict = decideAccountCreation({ ...input, kind: input.kind ?? 'api_key', approver: actorUserId });
      if (!verdict.ok) return verdict;

      const tenantId = deriveTenantId({ owner: ownerRef });
      const row = await deps.accounts.insert({ draft: verdict.draft, owner: ownerRef, tenantId, approvalPolicy: verdict.draft.approvalPolicy });
      const { scope, bindings } = planeBindingsFor({ row, boundAgentPageIds: [], hash: deps.hash });
      const consenters: PlanePutBody['consenters'] = ownerRef.kind === 'user' ? { kind: 'owner' } : { kind: 'pinned', userIds: [...(await deps.facts.driveConsenters(ownerRef.driveId))] };

      const put = await deps.plane.put({
        ref: { tenantId, accountId: row.id, kind: verdict.draft.kind },
        material:
          verdict.draft.kind === 'bearer'
            ? { kind: 'bearer', material: { token: input.apiKey, expiresAt: null } }
            : { kind: 'api_key', material: { value: input.apiKey, placement: verdict.draft.placement } },
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

    async listAccounts({ actor, owner, allowedDriveIds = [] }) {
      const actorUserId = actor.userId as UserId;
      const withinCeiling = (row: AgentAccountRecord) => isDriveWithinCredentialScope(allowedDriveIds, row.ownerDriveId);
      if (owner.kind === 'user') return (await deps.accounts.listForUser(actorUserId)).filter(withinCeiling).map((row) => toSafeAccount({ row }));
      // Decided from the caller's standing on the page BEFORE any row is read, so a refusal says nothing about
      // whether the page has accounts (review LOW-2).
      const driveId = await deps.facts.pageDrive(owner.agentPageId);
      if (driveId === null) return null;
      const humanDriveRole = await deps.facts.driveRole({ driveId, actor });
      const pagePermission = await deps.facts.pagePermission({ actor, pageId: owner.agentPageId });
      if (!decideAccountListView({ humanDriveRole, pagePermission })) return null;
      // An account minted in the page's previous drive stays bound to that drive (its tenant is immutable): not listed here.
      const owned = (await deps.accounts.listForAgentPage(owner.agentPageId)).filter((row) => row.ownerDriveId === driveId && withinCeiling(row));
      // The viewer's OWN accounts attached to this agent — never anyone else's (a binding does not share an account).
      const attached = (await deps.accounts.listBoundForUserOnPage({ agentPageId: owner.agentPageId, userId: actorUserId })).filter(withinCeiling);
      return [...owned, ...attached].map((row) => toSafeAccount({ row }));
    },

    async revokeAccount({ actor, accountId }) {
      const row = await deps.accounts.find(accountId);
      if (row === null || !(await accessOf(row, actor)).manage) return { ok: false, reason: 'account_unavailable' };
      const ref = refOf(row);
      // A not-ready account (its first put never committed) may still have left material in the vault with no
      // plane record to revoke: erase it outright instead (second review MED-1).
      const done = row.credentialVersion === 0 ? await deps.plane.delete({ ref }) : await deps.plane.revoke({ ref });
      if (!done.ok && done.reason !== 'not_found') return { ok: false, reason: 'plane_unavailable' };
      const marked = await deps.accounts.markRevoked({ id: row.id, at: deps.now() });
      return marked === null ? { ok: false, reason: 'account_unavailable' } : { ok: true, account: toSafeAccount({ row: marked }) };
    },

    async requestOperation({ actor, caller, accountId, request }) {
      // The human's standing is read through THEIR credential; any other actor is refused outright.
      if (actor.userId !== caller.actingHumanUserId) return { ok: false, reason: 'refused' };
      const now = deps.now();
      const row = await deps.accounts.find(accountId);
      const humanDriveRole = row?.ownerDriveId ? await deps.facts.driveRole({ driveId: row.ownerDriveId, actor }) : null;
      const agentPagePermission = caller.agentPageId === null ? 'none' : await deps.facts.pagePermission({ actor, pageId: caller.agentPageId });
      const boundAgentPageIds = row === null ? [] : await deps.accounts.boundAgentPageIds(row.id);
      // An unattended run is admitted only by a delegation from THIS human for THIS account on THIS agent page.
      const delegation: DelegationFact =
        row === null || caller.sessionId !== null
          ? { kind: 'none' }
          : ((await deps.accounts.activeDelegation({ accountId: row.id, agentPageId: caller.agentPageId, delegatedByUserId: caller.actingHumanUserId, now })) ?? { kind: 'none' });
      // The policy window's real counters, so a cap refuses here with its reason; the plane re-checks and reserves.
      const counted = row === null || row.approvalPolicy === null ? null : await deps.plane.usage({ ref: refOf(row) });
      const usage: UsageCounters = counted !== null && counted.ok ? { usesThisHour: counted.usesThisHour, bytesOutThisHour: counted.bytesOutThisHour, concurrent: counted.concurrent } : ZERO_USAGE;
      const verdict = authorize({
        caller,
        account: row,
        facts: {
          humanDriveRole,
          agentPagePermission,
          agentBoundToAccount: caller.agentPageId !== null && boundAgentPageIds.includes(caller.agentPageId),
          boundAgentPageIds,
          delegation,
          ceilingAdmitsAccount: isDriveWithinCredentialScope(caller.callerCeiling.allowedDriveIds, row?.ownerDriveId ?? null),
        },
        request,
        registry: deps.registry,
        approvals: row === null ? [] : await deps.accounts.openApprovals({ accountId: row.id, now }),
        usage,
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

    async approveRequest({ actor, sessionId, accountId, requestDigest, stepUp = null }) {
      const actorUserId = actor.userId as UserId;
      const row = await deps.accounts.find(accountId);
      if (row === null || !(await accessOf(row, actor)).use) return { ok: false, reason: 'account_unavailable' };
      const expiresAt = deps.now() + APPROVAL_TTL_MS;
      const approvalId = await deps.accounts.insertApproval({ accountId: row.id, requestDigest: requestDigest as RequestDigest, approvedByUserId: actorUserId, approvedViaSessionId: sessionId, stepUpChallengeId: stepUp?.challengeId ?? null, expiresAt });
      return { ok: true, approvalId, expiresAt };
    },

    async probeSshHost({ actor, owner, host, port }) {
      const allowed = await creatableOwner(actor, owner);
      if (!allowed.ok) return allowed;
      const target = normalizeSshTarget({ host, port });
      if (!target.ok) return target;
      const probed = await deps.plane.sshHostKey({ host: target.host, port: target.port });
      return probed.ok ? { ok: true, target: target.target, fingerprint: probed.fingerprint, algorithm: probed.algorithm } : probed;
    },

    async createSshAccount({ actor, owner, input }) {
      const allowed = await creatableOwner(actor, owner);
      if (!allowed.ok) return allowed;
      const verdict = decideSshAccount({ input, approver: actor.userId as UserId });
      if (!verdict.ok) return verdict;
      const { ownerRef } = allowed;
      const tenantId = deriveTenantId({ owner: ownerRef });
      const row = await deps.accounts.insert({ draft: verdict.draft, owner: ownerRef, tenantId, approvalPolicy: verdict.draft.approvalPolicy });
      const { scope, bindings } = planeBindingsFor({ row, boundAgentPageIds: [], hash: deps.hash });
      const consenters: PlanePutBody['consenters'] = ownerRef.kind === 'user' ? { kind: 'owner' } : { kind: 'pinned', userIds: [...(await deps.facts.driveConsenters(ownerRef.driveId))] };
      const enrolled = await deps.plane.sshEnroll({
        ref: { tenantId, accountId: row.id, kind: 'ssh_key' },
        username: verdict.draft.username,
        hostKeySha256: verdict.draft.hostKeySha256,
        bindings: bindings as unknown as Record<string, unknown>,
        scope: scope as unknown as Record<string, unknown>,
        consenters,
      });
      if (!enrolled.ok) {
        const definite = enrolled.reason === 'target_invalid' || enrolled.reason === 'kind_mismatch' || enrolled.reason === 'consenters_invalid' || enrolled.reason === 'identity_refused' || enrolled.reason === 'version_conflict';
        if (definite) await deps.accounts.remove(row.id);
        return { ok: false, reason: definite ? 'store_refused' : 'plane_unavailable' };
      }
      await deps.accounts.setCredentialVersion({ id: row.id, version: enrolled.version });
      await deps.accounts.setPublicKey({ id: row.id, publicKey: enrolled.publicKey });
      const stored = await deps.accounts.find(row.id);
      return stored === null ? { ok: false, reason: 'store_refused' } : { ok: true, account: toSafeAccount({ row: stored }), publicKey: enrolled.publicKey };
    },

    async requestSshCommand({ actor, caller, accountId, command, stdin }) {
      if (actor.userId !== caller.actingHumanUserId) return { ok: false, reason: 'refused' };
      const now = deps.now();
      const row = await deps.accounts.find(accountId);
      const humanDriveRole = row?.ownerDriveId ? await deps.facts.driveRole({ driveId: row.ownerDriveId, actor }) : null;
      const agentPagePermission = caller.agentPageId === null ? 'none' : await deps.facts.pagePermission({ actor, pageId: caller.agentPageId });
      const boundAgentPageIds = row === null ? [] : await deps.accounts.boundAgentPageIds(row.id);
      const delegation: DelegationFact =
        row === null || caller.sessionId !== null
          ? { kind: 'none' }
          : ((await deps.accounts.activeDelegation({ accountId: row.id, agentPageId: caller.agentPageId, delegatedByUserId: caller.actingHumanUserId, now })) ?? { kind: 'none' });
      const counted = row === null || row.approvalPolicy === null ? null : await deps.plane.usage({ ref: refOf(row) });
      const usage: UsageCounters = counted !== null && counted.ok ? { usesThisHour: counted.usesThisHour, bytesOutThisHour: counted.bytesOutThisHour, concurrent: counted.concurrent } : ZERO_USAGE;
      const verdict = authorizeSsh({
        caller,
        account: row,
        facts: {
          humanDriveRole,
          agentPagePermission,
          agentBoundToAccount: caller.agentPageId !== null && boundAgentPageIds.includes(caller.agentPageId),
          boundAgentPageIds,
          delegation,
          ceilingAdmitsAccount: isDriveWithinCredentialScope(caller.callerCeiling.allowedDriveIds, row?.ownerDriveId ?? null),
        },
        command,
        stdin,
        sha256: deps.sha256,
        approvals: row === null ? [] : await deps.accounts.openApprovals({ accountId: row.id, now }),
        usage,
        presenter: { keyId: deps.presenterKeyId, channel: 'ssh-executor' },
        now,
        grantId: newId() as GrantId,
        nonce: newId() as Nonce,
        ttlMs: GRANT_TTL_MS,
        hash: deps.hash,
      });
      const subjectOf = (canonical: Parameters<typeof renderApprovalSubject>[0]['canonical']): ApprovalSubject => {
        const target = sshTargetOf(canonical.origin);
        return { ...renderApprovalSubject({ canonical }), headline: `Run a command on ${target?.host ?? canonical.origin}${stdin.length > 0 ? ' (with input)' : ''}`, command };
      };
      if (!verdict.ok) {
        if (verdict.reason !== 'approval_required') return verdict;
        return { ...verdict, subject: { ...verdict.subject, headline: `Run a command on ${sshTargetOf(verdict.subject.origin)?.host ?? verdict.subject.origin}`, command } };
      }
      if (verdict.approvalToConsume !== null) {
        const consumed = await deps.accounts.consumeApproval({ approvalId: verdict.approvalToConsume, grantId: verdict.grant.grantId, now });
        if (!consumed) return { ok: false, reason: 'approval_required', digest: verdict.grant.requestDigest, subject: subjectOf(verdict.canonical), stepUp: verdict.approvalStepUp };
      }
      const signature = signGrant({ grant: verdict.grant, key: deps.authorityKey });
      return deps.plane.sshExec({
        grant: verdict.grant,
        signature,
        command,
        stdin,
        run: { human: verdict.grant.human, agentPageId: verdict.grant.agentPageId, conversationId: verdict.grant.conversationId, runId: verdict.grant.runId },
      }) as Promise<SshCommandResult>;
    },

    async prepareOAuthEnrollment({ actor, owner, input }) {
      const allowed = await creatableOwner(actor, owner);
      if (!allowed.ok) return allowed;
      const verdict = decideGoogleEnrollment({ input, approver: actor.userId as UserId });
      return verdict.ok ? { ok: true, requestedScopes: verdict.draft.requestedScopes } : verdict;
    },

    async completeOAuthEnrollment({ actor, owner, input, code, codeVerifier, redirectUri }) {
      const allowed = await creatableOwner(actor, owner);
      if (!allowed.ok) return allowed;
      const verdict = decideGoogleEnrollment({ input, approver: actor.userId as UserId });
      if (!verdict.ok) return verdict;
      const { ownerRef } = allowed;
      const tenantId = deriveTenantId({ owner: ownerRef });
      const row = await deps.accounts.insert({ draft: verdict.draft, owner: ownerRef, tenantId, approvalPolicy: verdict.draft.approvalPolicy });
      const { scope, bindings } = planeBindingsFor({ row, boundAgentPageIds: [], hash: deps.hash });
      const consenters: PlanePutBody['consenters'] = ownerRef.kind === 'user' ? { kind: 'owner' } : { kind: 'pinned', userIds: [...(await deps.facts.driveConsenters(ownerRef.driveId))] };
      const exchanged = await deps.plane.oauthExchange({
        ref: { tenantId, accountId: row.id, kind: 'oauth2' },
        providerSlug: 'google',
        code,
        codeVerifier,
        redirectUri,
        requestedScopes: [...verdict.draft.requestedScopes],
        bindings: bindings as unknown as Record<string, unknown>,
        scope: scope as unknown as Record<string, unknown>,
        consenters,
      });
      if (!exchanged.ok) {
        // Refused before anything was stored (the code, the id token, the client): the row goes. A store
        // failure after the exchange may have left material: the row stays not-ready and revocable.
        const nothingStored = exchanged.reason !== 'store_unavailable' && exchanged.reason !== 'write_unverified' && exchanged.reason !== 'lock_unavailable' && exchanged.reason !== 'plane_unavailable';
        if (nothingStored) await deps.accounts.remove(row.id);
        if (exchanged.reason === 'plane_unavailable') return { ok: false, reason: 'plane_unavailable' };
        return nothingStored ? { ok: false, reason: 'provider_refused', detail: exchanged.reason as Extract<PlaneOAuthExchangeResult, { readonly ok: false }>['reason'] } : { ok: false, reason: 'store_refused' };
      }
      await deps.accounts.setCredentialVersion({ id: row.id, version: exchanged.version });
      // Which Google account it is, in the name the agent and the person see.
      await deps.accounts.setName({ id: row.id, name: `${verdict.draft.name} (${exchanged.email})`.slice(0, 200) });
      const stored = await deps.accounts.find(row.id);
      return stored === null ? { ok: false, reason: 'store_refused' } : { ok: true, account: toSafeAccount({ row: stored }), email: exchanged.email };
    },

    async describeAccount({ actor, accountId }) {
      const row = await deps.accounts.find(accountId);
      if (row === null || !(await accessOf(row, actor)).manage) return refused('account_unavailable');
      return { ok: true, settings: await settingsOf(row) };
    },

    async updateAccount({ actor, accountId, edit, stepUp }) {
      return serialized(accountId, actor, async (row) => {
      const stored = (row.approvalPolicy ?? null) as AccountApprovalPolicy | null;
      const bound = await deps.accounts.boundAgentPageIds(row.id);
      // First as the stored approver: if that cannot widen the policy, the approver stays (no consent needed).
      const asStored = decideAccountEdit({ edit, editor: actor.userId as UserId, storedApprover: stored?.approver ?? null, keepApprover: true, providerSlug: row.providerSlug, sshTarget: sshTargetOfRow(row), providerOrigins: providerOriginsOf(row), now: deps.now() });
      if (!asStored.ok) return asStored;
      const current = planeBindingsFor({ row, boundAgentPageIds: bound, hash: deps.hash }).scope;
      const narrowsAsStored = isScopeNarrowing({ stored: current, next: { ...current, allowedOrigins: [...asStored.allowedOrigins].sort(), approvalPolicy: asStored.approvalPolicy } as PlaneScope });
      const verdict = narrowsAsStored ? asStored : decideAccountEdit({ edit, editor: actor.userId as UserId, storedApprover: null, keepApprover: false, providerSlug: row.providerSlug, sshTarget: sshTargetOfRow(row), providerOrigins: providerOriginsOf(row), now: deps.now() });
      if (!verdict.ok) return verdict;
      const next = { allowedOrigins: verdict.allowedOrigins, approvalPolicy: verdict.approvalPolicy };
      const rebound = await rebindTo({ row, next, boundAgentPageIds: bound, actor, stepUp });
      if (!rebound.ok) return rebound;
      const updated = await recordScope(row, next, rebound.policyVersion);
      return updated === null ? refused('conflict') : { ok: true, settings: await settingsOf(updated) };
      });
    },

    async bindAccount({ actor, accountId, agentPageId, stepUp }) {
      return serialized(accountId, actor, async (row) => {
      if (row.ownerKind !== 'user') return refused('account_unavailable');
      // ADR 0005 §4.3: only to an AGENT page the owner can edit; a binding never shares the account with other people.
      if (!(await deps.facts.isAgentPage(agentPageId)) || (await deps.facts.pagePermission({ actor, pageId: agentPageId })) !== 'edit') return refused('page_unavailable');
      const bound = await deps.accounts.boundAgentPageIds(row.id);
      if (!bound.includes(agentPageId as AgentPageId) && bound.length >= MAX_BOUND_AGENT_PAGES) return refused('bindings_full');
      const nextBound = [...new Set([...bound, agentPageId as AgentPageId])];
      // Plane first, then the row, then the binding: until all three land, the digest the authority
      // signs disagrees with the plane, so the account fails closed — never wider than either side.
      const rebound = await rebindTo({ row, next: unchangedScope(row), boundAgentPageIds: nextBound, actor, stepUp });
      if (!rebound.ok) return rebound;
      const updated = await recordScope(row, unchangedScope(row), rebound.policyVersion);
      if (updated === null) return refused('conflict');
      await deps.accounts.upsertBinding({ accountId: row.id, agentPageId, boundByUserId: actor.userId, at: deps.now() });
      return { ok: true, settings: await settingsOf(updated) };
      });
    },

    async unbindAccount({ actor, accountId, agentPageId }) {
      return serialized(accountId, actor, async (row) => {
      if (row.ownerKind !== 'user') return refused('account_unavailable');
      // Plane first (a narrowing: no consent). Until the row and binding follow, the account fails closed,
      // and the binding stays listed so a failed detach can simply be retried.
      const nextBound = (await deps.accounts.boundAgentPageIds(row.id)).filter((id) => id !== agentPageId);
      const rebound = await rebindTo({ row, next: unchangedScope(row), boundAgentPageIds: nextBound, actor, stepUp: null });
      if (!rebound.ok) return rebound;
      const updated = await recordScope(row, unchangedScope(row), rebound.policyVersion);
      if (updated === null) return refused('conflict');
      const at = deps.now();
      await deps.accounts.revokeBinding({ accountId: row.id, agentPageId, at });
      // Unattended use on that agent ends with the attachment: re-attaching later never revives it.
      await deps.accounts.revokeDelegationsForPage({ accountId: row.id, agentPageId, at });
      return { ok: true, settings: await settingsOf(updated) };
      });
    },

    async createDelegation({ actor, accountId, agentPageId, expiresAt, stepUp }) {
      const row = await changeable(accountId, actor);
      if (row === null) return refused('account_unavailable');
      if (stepUp === null) return refused('step_up_required');
      const now = deps.now();
      if (!Number.isInteger(expiresAt) || expiresAt < now + MIN_DELEGATION_MS || expiresAt > now + MAX_DELEGATION_MS) return refused('expiry_invalid');
      // The page the unattended runs drive: the owner page, or a page a user-owned account is attached to.
      const pageAdmits = row.ownerKind === 'agent_page' ? row.ownerAgentPageId === agentPageId : (await deps.accounts.boundAgentPageIds(row.id)).includes(agentPageId as AgentPageId);
      if (!pageAdmits) return refused('page_unavailable');
      const policy = (row.approvalPolicy ?? null) as AccountApprovalPolicy | null;
      if (autoApproveOf(policy) === null || policy === null) return refused('auto_approve_required');
      // What is delegated is the policy's reach at this moment: widening the account later widens no delegation.
      await deps.accounts.insertDelegation({
        accountId: row.id,
        agentPageId,
        delegatedByUserId: actor.userId,
        scope: { origins: [...policy.scope.origins], operations: policy.scope.operations.map((operation) => ({ ...operation })), resources: [] },
        expiresAt,
      });
      return { ok: true, settings: await settingsOf(row) };
    },

    async revokeDelegation({ actor, accountId, delegationId }) {
      const row = await deps.accounts.find(accountId);
      if (row === null || !(await accessOf(row, actor)).manage) return refused('account_unavailable');
      const revoked = await deps.accounts.revokeDelegation({ id: delegationId as DelegationId, accountId: row.id, at: deps.now() });
      return revoked ? { ok: true, settings: await settingsOf(row) } : refused('delegation_unavailable');
    },
  };
}

