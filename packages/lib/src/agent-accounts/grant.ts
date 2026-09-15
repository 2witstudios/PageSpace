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
import type { AccountId, AccountKind, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';

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
   * `(tenantId, ownerRef, allowedOrigins, policyVersion, kind)`. The store
   * compares it with the digest of ITS copy at resolve, so a main-DB writer
   * who reassigns the owner or widens origins cannot produce a grant the
   * plane honours (threat model A9; Codex P1 on PR #2637).
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
 * THE one canonical deny union (ADR 0004 §6 F1–F17, in deny order).
 * `Record<GrantDenyReason, V>` is used wherever per-reason data exists so an
 * added variant fails typecheck everywhere it matters.
 */
export type GrantDenyReason =
  | 'malformed'
  | 'wrong_audience'
  | 'ceiling'
  | 'tenant_mismatch'
  | 'principal_mismatch'
  | 'version_mismatch'
  | 'policy_epoch'
  | 'no_delegation'
  | 'digest_mismatch'
  | 'generation_mismatch'
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
   */
  | { readonly kind: 'concrete'; readonly approvalId: ApprovalId; readonly requestDigest: RequestDigest; readonly consumedByGrantId: GrantId | null }
  | { readonly kind: 'policy'; readonly policyVersion: PolicyVersion; readonly expired: boolean; readonly limitsExceeded: boolean }
  | { readonly kind: 'none' };

/** The delegation row's facts (ADR 0004 §4.4). */
export type DelegationFact =
  | { readonly kind: 'live_session' }
  | { readonly kind: 'delegation'; readonly delegationId: DelegationId; readonly accountId: AccountId; readonly expired: boolean; readonly revoked: boolean }
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
  readonly accountDriveId: DriveId | null;
  readonly currentCredentialVersion: CredentialVersion;
  readonly currentPolicyVersion: PolicyVersion;
  readonly delegation: DelegationFact;
  /** The provisioner's current view; null when unavailable (→ `generation_mismatch`, never `ok`). */
  readonly sandbox: { readonly instanceId: SandboxInstanceId; readonly generation: SandboxGeneration } | null;
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
  /** The request the presenter is about to execute; its digest is recomputed here. */
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
