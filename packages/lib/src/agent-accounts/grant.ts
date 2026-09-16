/**
 * THE ACTION GRANT — the unit of authorization for every credentialed
 * operation (ADR 0004 §2; threat model §3 principals, §4 intersection).
 *
 * Frozen at L1·G1a. This file is TYPES ONLY: the shapes every later gate
 * consumes and G1b implements (`verify-grant.ts`, `parse-grant.ts`). A change
 * to any type here is a [D-n], not a PR (Control Board §1).
 *
 * Why a sibling of `env-bridge/grant.ts` and not a reuse of it: the bridge
 * grant names three principals ({userId, sessionId, conversationId}) and is
 * signed for a user's own daemon. A credentialed operation must name eleven
 * (human, delegation, tenant, agent page, conversation, run, sandbox
 * instance + generation, caller ceiling, presenter, account + credential
 * version, policy version) under a SEPARATE issuer key and audience, so a
 * bridge grant can never verify as an account grant. The verification
 * discipline is inherited (pure, injected clock/hash/verify, fixed deny
 * order, nonce recorded only on `ok`); the shape is not.
 *
 * Every field is REQUIRED. `null` is a legal value only where the doc comment
 * says so; `undefined` and missing keys are `malformed`. Principal ids are
 * BRANDED so the compiler refuses a `RunId` where a `SandboxInstanceId` is
 * expected (Control Board §7.5).
 */
import type { AgentDispatchPayload } from '../auth/agent-dispatch-payload';
import type { AccountId, AccountKind, AccountStatus, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';

// ---------------------------------------------------------------------------
// Branded principals (threat model §3). One brand per principal; never
// interchangeable. Ids that already have a home in the db layer (AccountId,
// TenantId, CredentialVersion, PolicyVersion) are imported, not redefined.
// ---------------------------------------------------------------------------

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type DelegationId = Brand<string, 'DelegationId'>;
export type AgentPageId = Brand<string, 'AgentPageId'>;
export type DriveId = Brand<string, 'DriveId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type RunId = Brand<string, 'RunId'>;
export type SpriteName = Brand<string, 'SpriteName'>;
export type SandboxInstanceId = Brand<string, 'SandboxInstanceId'>;
export type SandboxGeneration = Brand<number, 'SandboxGeneration'>;
export type GrantId = Brand<string, 'GrantId'>;
export type Nonce = Brand<string, 'Nonce'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type PresenterKeyId = Brand<string, 'PresenterKeyId'>;
export type RequestDigest = Brand<string, 'RequestDigest'>;
/** `hash(canonicalJson(PlaneBindings))` — the authority's signed copy of the plane bindings (ADR 0005 §2.4). */
export type BindingDigest = Brand<string, 'BindingDigest'>;

/** The issuer constant. A grant with any other `iss` is `wrong_audience`. */
export type GrantIssuer = 'pagespace-account-authority';

/**
 * Who may PRESENT a grant to the plane. Executors only; the sandbox guest is
 * never a channel (ADR 0006). `refresh-worker` may resolve `oauth2` only.
 */
export type PresenterChannel = 'http-executor' | 'relay-runner' | 'browser-worker' | 'refresh-worker';

/** The channels that may call `resolve` for end-user operations (ADR 0005 §2.1). */
export type ExecutorChannel = Exclude<PresenterChannel, 'refresh-worker'>;

/**
 * Typed operation semantics decide approval; HTTP method never does
 * (ADR 0004 §3.4). `unknown` = a generic request with no reviewed schema.
 */
export type OperationClass = 'read' | 'write' | 'irreversible' | 'privilege' | 'unknown';

export type OperationRef = {
  readonly class: OperationClass;
  readonly name: string;
};

/**
 * The sandbox a relay operation executes against (ADR 0006 §3). All three
 * required when present. `instanceId` catches recreate; `generation` catches
 * restore. Neither is secret; the binding's security is the org-token channel
 * and the digest.
 */
export type SandboxBinding = {
  readonly spriteName: SpriteName;
  readonly instanceId: SandboxInstanceId;
  readonly generation: SandboxGeneration;
};

/**
 * The Sign-in epic's caller-limit model, CONSUMED not forked: the same
 * `allowedDriveIds` ceiling `AgentDispatchPayload` carries across hops
 * (`[]` = no ceiling), evaluated by `isDriveWithinCredentialScope`
 * (`agent-workspaces/credential-scope.ts`). Asked FIRST (axiom 8).
 */
export type CallerCeiling = {
  readonly allowedDriveIds: AgentDispatchPayload['allowedDriveIds'];
  /** Non-null when the chain started at a scoped MCP token. */
  readonly originatingMcpTokenId: string | null;
};

export type GrantHuman = {
  readonly userId: UserId;
  /** Non-null for a live human session; null ONLY when `delegationId` is non-null. */
  readonly sessionId: SessionId | null;
};

export type GrantPresenter = {
  readonly keyId: PresenterKeyId;
  /** Must equal `aud`. */
  readonly channel: PresenterChannel;
};

/**
 * The frozen grant (ADR 0004 §2.1). Field order here is the canonical signing
 * order `encodeGrant` (G1b) rebuilds from the typed value.
 */
export type AgentAccountGrant = {
  readonly grantId: GrantId;
  readonly iss: GrantIssuer;
  readonly aud: PresenterChannel;
  readonly tenantId: TenantId;
  readonly human: GrantHuman;
  /** The recorded delegation for an unattended run; null only when `human.sessionId` is non-null. */
  readonly delegationId: DelegationId | null;
  /** null for the global assistant. */
  readonly agentPageId: AgentPageId | null;
  readonly conversationId: ConversationId;
  readonly runId: RunId;
  /** Required non-null iff `aud === 'relay-runner'`. */
  readonly sandbox: SandboxBinding | null;
  readonly callerCeiling: CallerCeiling;
  readonly accountId: AccountId;
  readonly accountKind: AccountKind;
  readonly credentialVersion: CredentialVersion;
  readonly policyVersion: PolicyVersion;
  /**
   * The authority's signed digest of the plane bindings it evaluated
   * `(tenantId, ownerRef, allowedOrigins, policyVersion, policyDigest, kind)`.
   * The store compares it with the digest of ITS copy at resolve, so a
   * main-DB writer who reassigns the owner, widens origins, or widens the
   * approval policy / resource restrictions / agent-page bindings (all inside
   * `policyDigest`) cannot produce a grant the plane honours (threat model A9;
   * Codex P1 on PR #2637; G1a review H1).
   */
  readonly bindingDigest: BindingDigest;
  readonly operation: OperationRef;
  readonly requestDigest: RequestDigest;
  /**
   * True only when the account's default-off `session_http` permission is
   * enabled AND `decideAccountAccess` granted it; the sole way a `session`
   * kind may reach the HTTP executor (ADR 0005 §4.2). Always false for every
   * other kind and channel.
   */
  readonly sessionHttp: boolean;
  /** The consumed approval, or the `'policy'` sentinel for a bounded always-allow (ADR 0004 §4.3). */
  readonly approvalId: ApprovalId | 'policy';
  /** ms since epoch. */
  readonly iat: number;
  readonly nbf: number;
  /** `exp - iat <= GrantLimits['maxTtlMs']`. */
  readonly exp: number;
  readonly nonce: Nonce;
  readonly presenter: GrantPresenter;
};

/** Frozen numbers (ADR 0004 §2.3) as literal types; G1b exports the values. */
export type GrantLimits = {
  readonly maxTtlMs: 900_000;
  readonly maxClockSkewMs: 30_000;
};

/**
 * THE one canonical deny union (every reason ADR 0004 §6 names, in deny
 * order; `audit_unavailable` is returned by the executor, not the verifier).
 * `Record<GrantDenyReason, V>` is used wherever per-reason data exists so an
 * added variant fails typecheck everywhere it matters.
 */
export type GrantDenyReason =
  | 'malformed'
  | 'wrong_audience'
  | 'ceiling'
  | 'tenant_mismatch'
  | 'principal_mismatch'
  /** `expected.accountStatus` is anything but `active` (F5); the status itself goes to audit. */
  | 'account_not_active'
  | 'version_mismatch'
  | 'policy_epoch'
  | 'no_delegation'
  | 'digest_mismatch'
  | 'generation_mismatch'
  /** The grant names a sandbox but the presenter could not observe its current binding (`getSprite` unreachable) — never `ok` (ADR 0006 F5). */
  | 'binding_unavailable'
  | 'ttl_too_long'
  | 'clock_skew'
  | 'not_yet_valid'
  | 'expired'
  | 'bad_signature'
  | 'replayed'
  | 'replay_store_unavailable'
  | 'audit_unavailable'
  | 'approval_mismatch'
  | 'kind_not_resolvable';

export type GrantVerdict =
  | { readonly ok: true; readonly grant: AgentAccountGrant }
  | { readonly ok: false; readonly reason: GrantDenyReason };

export type ParseGrantVerdict =
  | { readonly ok: true; readonly grant: AgentAccountGrant }
  | { readonly ok: false; readonly reason: 'malformed' };

/** Injected primitives, as in the env-bridge: the verifier never touches `node:crypto`. */
export type Ed25519Verify = (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;
export type HashBytes = (bytes: Uint8Array) => string;

/** The result of the replay store's I/O, handed to the pure verifier (ADR 0004 §2.4). */
export type NonceState = 'fresh' | 'consumed' | 'unknown';

/** The approval row's facts, fetched by the repository (ADR 0004 §4.3). */
export type ApprovalFact =
  /**
   * An allow-once row is consumed BY the grant issuance that used it, so the
   * verifier accepts it only when `consumedByGrantId` equals the signed
   * `grantId`: `null` means never issued against (a forged/unissued grant),
   * another id means a competing issuance won (Codex P1 on PR #2637).
   *
   * It also names the ACCOUNT it was given for and its expiry, so the
   * verifier — not only issuance — refuses an approval recorded for another
   * account or one that had expired when the grant was issued
   * (`grant.iat > expiresAt`) (G1a review M3).
   */
  | {
      readonly kind: 'concrete';
      readonly approvalId: ApprovalId;
      readonly accountId: AccountId;
      readonly requestDigest: RequestDigest;
      readonly consumedByGrantId: GrantId | null;
      /** `agent_account_approvals.expiresAt`, ms since epoch. */
      readonly expiresAt: number;
    }
  | { readonly kind: 'policy'; readonly policyVersion: PolicyVersion; readonly expired: boolean; readonly limitsExceeded: boolean }
  | { readonly kind: 'none' };

/**
 * The delegation row's facts (ADR 0004 §4.4). A delegation is consent from ONE
 * human for ONE account on ONE agent page: the verifier compares
 * `delegationId`, `accountId`, `agentPageId` (against `grant.agentPageId`) and
 * `delegatedBy` (against `grant.human.userId`), so a delegation recorded for
 * page P by user U never verifies for page Q or human V (G1a review H3).
 */
export type DelegationFact =
  | { readonly kind: 'live_session' }
  | {
      readonly kind: 'delegation';
      readonly delegationId: DelegationId;
      readonly accountId: AccountId;
      /** `agent_account_delegations.agentPageId`; null only for a delegation to the global assistant. */
      readonly agentPageId: AgentPageId | null;
      /** `agent_account_delegations.delegatedByUserId`. */
      readonly delegatedBy: UserId;
      readonly expired: boolean;
      readonly revoked: boolean;
    }
  | { readonly kind: 'none' };

/**
 * Everything the verifier compares the grant against — all FACTS the adapter
 * fetched, never handles. Deliberately no field can carry a guest-supplied
 * header or IP (ADR 0006 §8 assertion 4).
 *
 * The CURRENT execution principals (`human`, `agentPageId`, `conversationId`,
 * `runId`) come from the presenter's own run context, never from the grant,
 * so a valid unused grant issued for another agent page, thread or run that
 * reaches the same presenter is `principal_mismatch` (Codex P1 on PR #2637).
 */
export type ExpectedBinding = {
  readonly aud: PresenterChannel;
  readonly presenter: GrantPresenter;
  readonly human: GrantHuman;
  readonly agentPageId: AgentPageId | null;
  readonly conversationId: ConversationId;
  readonly runId: RunId;
  readonly tenantId: TenantId;
  readonly accountId: AccountId;
  readonly accountKind: AccountKind;
  /**
   * `agent_accounts.status` as the adapter read it. Anything but `active`
   * (`needs_reauth`, `revoked`, `deleted`) is `account_not_active` before any
   * version is compared — the verifier, not only the plane, ends use of a
   * revoked account (ADR 0004 F5; G1a review H4).
   */
  readonly accountStatus: AccountStatus;
  readonly accountDriveId: DriveId | null;
  readonly currentCredentialVersion: CredentialVersion;
  readonly currentPolicyVersion: PolicyVersion;
  readonly delegation: DelegationFact;
  /**
   * The presenter's CURRENT observation of the sandbox — all three of
   * `spriteName`, `instanceId`, `generation`, compared field by field with
   * the signed `grant.sandbox` (any difference → `generation_mismatch`).
   * null when unobservable: a grant that names a sandbox then gets
   * `binding_unavailable`, never `ok` (ADR 0006 F5; G1a review M6).
   */
  readonly sandbox: SandboxBinding | null;
  /** `isDriveWithinCredentialScope(callerCeiling.allowedDriveIds, accountDriveId)`, computed by the adapter. */
  readonly ceilingAdmitsAccount: boolean;
};

export type VerifyGrantInput = {
  /** Untrusted: whatever arrived on the wire. */
  readonly grant: unknown;
  /** Base64 Ed25519 signature over `encodeGrant(grant)`. */
  readonly signature: string;
  readonly issuerPublicKey: Uint8Array;
  readonly now: number;
  readonly expected: ExpectedBinding;
  /**
   * `digestRequest` over the request the presenter is about to execute,
   * recomputed by the presenter's adapter from those bytes — never read from
   * the grant — and compared with the signed `requestDigest` (F8).
   */
  readonly requestDigest: RequestDigest;
  readonly requestOperation: OperationRef;
  readonly nonceState: NonceState;
  readonly approval: ApprovalFact;
  readonly verify: Ed25519Verify;
  readonly hash: HashBytes;
};

/** `parseGrant` — schema + structural sanity only (F1). G1b implements. */
export type ParseGrant = (input: { readonly grant: unknown }) => ParseGrantVerdict;

/** `verifyGrant` — the whole intersection as a pure function in fixed deny order (F1→F17). G1b implements. */
export type VerifyGrant = (input: VerifyGrantInput) => GrantVerdict;
