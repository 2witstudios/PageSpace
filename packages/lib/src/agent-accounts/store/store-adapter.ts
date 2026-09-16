/**
 * THE STORE ADAPTER INTERFACE (ADR 0005 §2). Frozen at L1·G1a; types only.
 * G1b implements `infisical-store-adapter.ts` (I/O) with the decisions in
 * `decide-store-write.ts` and `decide-resolve.ts` (pure).
 *
 * Backend is Infisical (D-21), one project per tenant (D-17). Infisical has
 * read-side versions but NO write-side compare-and-swap, so CAS is OURS:
 * version-check-then-write under a per-secret advisory lock in the plane's
 * metadata DB, with post-write verification. Deletion is split into what the
 * BROKER does (deny every future resolve) and what happened UPSTREAM (the
 * provider may still honour the key) — the two are reported separately.
 *
 * `resolve` is callable only by executor channels, and `password` material is
 * resolvable only by the browser-fill executor — expressed in the TYPE
 * (`ResolvableBy`) and re-checked at runtime by the adapter (D-20, Λ3).
 */
import type {
  AccountId,
  AccountKind,
  AccountOwnerRef,
  CredentialVersion,
  PolicyVersion,
  SessionFormat,
  TenantId,
} from '@pagespace/db/schema/agent-accounts';
import type { AgentAccountGrant, AgentPageId, BindingDigest, Brand, Ed25519Verify, HashBytes, PresenterChannel, UserId } from '../grant';
import type { CanonicalOrigin } from '../canonical-request';
import type { AccountApprovalPolicy } from '../approval';

/** Maps to the Infisical path `/<tenantProject>/<accountId>/<kind>`. */
export type SecretRef = {
  readonly tenantId: TenantId;
  readonly accountId: AccountId;
  readonly kind: AccountKind;
};

/**
 * The security-relevant SCOPE of an account — everything a main-DB writer
 * could widen without touching owner, tenant or kind: the approval policy,
 * the per-provider resource restrictions, the agent pages bound to the
 * account, and the allowed origins (ADR 0005 §2.4). Delegation and approval
 * rows are deliberately NOT here: each is protected by its own fact compared
 * against the signed grant (`DelegationFact`, `ApprovalFact`).
 */
export type PlaneScope = {
  readonly approvalPolicy: AccountApprovalPolicy | null;
  readonly resourceRestrictions: Readonly<Record<string, readonly string[]>>;
  /** Unrevoked `agent_account_bindings` plus the owner page of an agent-page-owned account; sorted before hashing. */
  readonly boundAgentPageIds: readonly AgentPageId[];
  readonly allowedOrigins: readonly CanonicalOrigin[];
};

/** SHA3-256 over `canonicalJson(PlaneScope)` (ADR 0005 §2.4). */
export type PolicyDigest = Brand<string, 'PolicyDigest'>;

/**
 * The plane's INDEPENDENT copy of the authority bindings, stored beside the
 * material and compared at resolve (threat model A9: a main-DB writer who
 * reassigns the owner, widens origins, OR widens the approval policy,
 * resource restrictions or agent-page bindings produces a grant whose
 * bindings disagree here). `policyDigest` is what makes the last three
 * visible to the plane: `policyVersion` is a counter a writer can leave
 * untouched, a digest is not.
 */
export type PlaneBindings = {
  readonly tenantId: TenantId;
  readonly ownerRef: AccountOwnerRef;
  readonly allowedOrigins: readonly CanonicalOrigin[];
  readonly policyVersion: PolicyVersion;
  readonly policyDigest: PolicyDigest;
  readonly kind: AccountKind;
};

/** Per-kind material — one canonical `Record<AccountKind, …>` (ADR 0005 §4.2). */
export type SecretMaterialByKind = {
  readonly api_key: {
    readonly value: string;
    readonly placement: { readonly in: 'header' | 'query'; readonly name: string };
  };
  readonly bearer: { readonly token: string; readonly expiresAt: number | null };
  readonly oauth2: {
    readonly accessToken: string;
    readonly accessExpiresAt: number;
    readonly refreshToken: string | null;
    readonly scopes: readonly string[];
    readonly issuer: string;
    readonly tokenEndpoint: string;
  };
  readonly session: {
    readonly format: Exclude<SessionFormat, 'human-relogin'>;
    readonly cookies: readonly SessionCookie[];
    /** Present only for `storage-state-v1`. */
    readonly storage: readonly SessionStorageEntry[] | null;
  };
  readonly password: {
    readonly username: string;
    readonly password: string;
    readonly totpSecret: string | null;
  };
};

export type SessionCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number | null;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: 'Strict' | 'Lax' | 'None';
};

export type SessionStorageEntry = {
  readonly origin: CanonicalOrigin;
  readonly localStorage: readonly (readonly [string, string])[];
  readonly indexedDb: readonly unknown[];
};

export type SecretMaterial = {
  readonly [K in AccountKind]: { readonly kind: K; readonly material: SecretMaterialByKind[K] };
}[AccountKind];

/**
 * Which kinds each channel may resolve through `resolve` (ADR 0005 §4.2).
 * `password` is the browser-fill executor's alone; `session` reaches the HTTP
 * executor ONLY through `resolveSessionOverHttp` under the account's
 * default-off `session_http` permission (Codex P1 on PR #2637). A call site
 * that tries otherwise does not compile (mutation pair required at G1b).
 */
export type ResolvableBy<C extends PresenterChannel> = {
  readonly 'http-executor': 'api_key' | 'bearer' | 'oauth2';
  readonly 'relay-runner': 'api_key' | 'bearer' | 'oauth2';
  readonly 'browser-worker': 'session' | 'password';
  readonly 'refresh-worker': 'oauth2';
}[C];

/** `oauth2` as ordinary executors see it: the access token only, never the refresh token. */
export type OAuth2AccessMaterial = Omit<SecretMaterialByKind['oauth2'], 'refreshToken'>;

/**
 * The material a CHANNEL receives per kind. Only the refresh worker ever
 * receives `oauth2.refreshToken`; every other channel gets
 * `OAuth2AccessMaterial` (Codex P1 on PR #2637: a compromised HTTP executor
 * must not expose long-lived refresh authority).
 */
export type MaterialForChannel<C extends PresenterChannel, K extends AccountKind> = C extends 'refresh-worker'
  ? SecretMaterialByKind[K]
  : K extends 'oauth2'
    ? OAuth2AccessMaterial
    : SecretMaterialByKind[K];

/** The tenant-scoped machine identity handle an executor holds. A parameter so a wrong-tenant identity is testable. */
export type StoreIdentity = {
  readonly tenantId: TenantId;
  readonly identityId: string;
  /** Per D-29's chosen model; reported so the audit can state the blast radius. */
  readonly blastRadius: 'tenant' | 'tier' | 'all';
};

/** A grant that already passed `verifyGrant` (nominal; the adapter never re-verifies). */
export type VerifiedGrant = AgentAccountGrant & { readonly __verified: true };

export type PutInput = {
  readonly ref: SecretRef;
  readonly material: SecretMaterial;
  /** null = create; otherwise the version the caller last observed (CAS). */
  readonly expectedVersion: CredentialVersion | null;
  readonly bindings: PlaneBindings;
  readonly identity: StoreIdentity;
};

export type PutResult =
  | { readonly ok: true; readonly version: CredentialVersion }
  | { readonly ok: false; readonly reason: 'version_conflict' | 'write_unverified' | 'lock_unavailable' | 'store_unavailable' | 'kind_mismatch' };

export type ResolveInput<C extends PresenterChannel, K extends ResolvableBy<C> = ResolvableBy<C>> = {
  readonly ref: SecretRef & { readonly kind: K };
  readonly version: CredentialVersion;
  readonly grant: VerifiedGrant & { readonly aud: C };
  readonly identity: StoreIdentity;
};

/**
 * The ONE audited exception by which a `session` kind reaches the HTTP
 * executor: the grant must carry `sessionHttp: true`, which the authority
 * signs only when the account's `sessionHttpEnabled` flag is on and
 * `decideAccountAccess` granted `session_http` (ADR 0004 §4.1).
 */
export type SessionHttpResolveInput = {
  readonly ref: SecretRef & { readonly kind: 'session' };
  readonly version: CredentialVersion;
  readonly grant: VerifiedGrant & { readonly aud: 'http-executor'; readonly sessionHttp: true };
  readonly identity: StoreIdentity;
};

export type ResolveDenyReason =
  | 'version_mismatch'
  | 'binding_mismatch'
  | 'kind_not_resolvable'
  | 'revoked'
  | 'not_found'
  | 'store_unavailable';

export type ResolveResult<C extends PresenterChannel, K extends AccountKind> =
  | { readonly ok: true; readonly kind: K; readonly material: MaterialForChannel<C, K>; readonly version: CredentialVersion }
  | { readonly ok: false; readonly reason: ResolveDenyReason };

export type RotateInput = {
  readonly ref: SecretRef;
  readonly expectedVersion: CredentialVersion;
  readonly next: SecretMaterial;
  readonly bindings: PlaneBindings;
  /** Only the refresh worker's identity may rotate. */
  readonly identity: StoreIdentity & { readonly channel: 'refresh-worker' };
};

export type RotateResult = PutResult;

/**
 * An authenticated owner consent to a binding change: the human who holds
 * `grant` on the account (ADR 0004 §4.1) passed step-up
 * (`auth/step-up-decisions.ts`) for EXACTLY these bindings. Signed by the
 * authority's step-up consent key (distinct from the grant key) so the plane
 * verifies it without reading the main DB; a DB writer cannot mint one.
 */
export type OwnerConsent = {
  readonly consentId: string;
  readonly consentingUserId: UserId;
  readonly stepUpChallengeId: string;
  /** `digestBindings` over the bindings being written — consent is to these bytes, not to "a change". */
  readonly bindingsDigest: BindingDigest;
  /** ms since epoch; the plane refuses a consent older than `StoreLimits['rebindConsentMaxAgeMs']`. */
  readonly issuedAt: number;
  /** Base64 Ed25519 over the canonical JSON of the fields above. */
  readonly signature: string;
};

/**
 * `rebind` — the ONE path that rewrites the plane's `PlaneBindings` without
 * touching material: a `policyVersion` bump (membership, instructions, copy,
 * move) or a widening (origins, policy, restrictions, agent bindings). CAS on
 * the stored `policyVersion`. Callable only by a MANAGE-audience identity —
 * held by the authority's management worker, never by `apps/web` — and only
 * with a valid `OwnerConsent` for these exact bindings (G1a review H2).
 */
export type RebindInput = {
  readonly ref: SecretRef;
  /** The `policyVersion` of the bindings the caller last observed in the plane (CAS). */
  readonly expectedVersion: PolicyVersion;
  /** `bindings.policyVersion` must be strictly greater than `expectedVersion`; tenant and kind must be unchanged. */
  readonly bindings: PlaneBindings;
  readonly consent: OwnerConsent;
  readonly identity: StoreIdentity & { readonly audience: 'manage' };
};

export type RebindResult =
  | { readonly ok: true; readonly policyVersion: PolicyVersion }
  | {
      readonly ok: false;
      readonly reason:
        | 'version_conflict'
        | 'consent_invalid'
        | 'immutable_binding_changed'
        | 'write_unverified'
        | 'lock_unavailable'
        | 'store_unavailable'
        | 'not_found';
    };

export type RevokeReason = 'owner_revoked' | 'policy_revoked' | 'rotation_replay' | 'erasure' | 'admin';

export type RevokeInput = { readonly ref: SecretRef; readonly reason: RevokeReason; readonly identity: StoreIdentity };
export type RevokeResult = { readonly ok: true; readonly revokedAt: number } | { readonly ok: false; readonly reason: 'not_found' | 'store_unavailable' };

/** What happened at the PROVIDER when we tried to revoke there. Reported, never inferred. */
export type UpstreamRevocation = 'revoked' | 'unsupported' | 'failed' | 'not_attempted';

export type DeleteInput = { readonly ref: SecretRef; readonly identity: StoreIdentity; readonly upstream: UpstreamRevocation };
export type DeleteResult =
  | { readonly ok: true; readonly removed: true; readonly upstream: UpstreamRevocation }
  | { readonly ok: false; readonly reason: 'not_found' | 'store_unavailable' };

export type DescribeInput = { readonly ref: SecretRef; readonly identity: StoreIdentity };
export type DescribeResult =
  | {
      readonly ok: true;
      readonly kind: AccountKind;
      readonly version: CredentialVersion;
      readonly bindings: PlaneBindings;
      readonly createdAt: number;
      readonly rotatedAt: number | null;
      readonly revokedAt: number | null;
    }
  | { readonly ok: false; readonly reason: 'not_found' | 'store_unavailable' };

/** The interface (ADR 0005 §2.2). Executors are the only `resolve` callers; the web process never holds a reading identity. */
export type StoreAdapter = {
  readonly put: (input: PutInput) => Promise<PutResult>;
  readonly resolve: <C extends PresenterChannel, K extends ResolvableBy<C>>(input: ResolveInput<C, K>) => Promise<ResolveResult<C, K>>;
  /** See `SessionHttpResolveInput`; unrepresentable without `grant.sessionHttp: true`. */
  readonly resolveSessionOverHttp: (input: SessionHttpResolveInput) => Promise<ResolveResult<'http-executor', 'session'>>;
  readonly rotate: (input: RotateInput) => Promise<RotateResult>;
  /** Manage-audience identity + owner consent only; see `RebindInput`. */
  readonly rebind: (input: RebindInput) => Promise<RebindResult>;
  readonly revoke: (input: RevokeInput) => Promise<RevokeResult>;
  readonly delete: (input: DeleteInput) => Promise<DeleteResult>;
  readonly describe: (input: DescribeInput) => Promise<DescribeResult>;
};

/** Frozen numbers (ADR 0005 §2.2) as literal types; G1b exports the values. */
export type StoreLimits = {
  /** The previous version stays resolvable to a grant that named it for this long after `rotate`. */
  readonly rotationGraceMs: 300_000;
  /** Revoked material is retained this long so an upstream revocation can still be attempted. */
  readonly revokeRetentionMs: 604_800_000;
  /** An `OwnerConsent` older than this is `consent_invalid` at `rebind`. */
  readonly rebindConsentMaxAgeMs: 300_000;
};

/** `decideStoreWrite` — our CAS as data (ADR 0005 §2.3). G1b implements. */
export type DecideStoreWrite = (input: {
  readonly expectedVersion: CredentialVersion | null;
  readonly observedBefore: CredentialVersion | null;
  readonly observedAfter: CredentialVersion | null;
  readonly bindingsAfter: PlaneBindings | null;
  readonly bindingsWritten: PlaneBindings;
}) =>
  | { readonly outcome: 'commit'; readonly version: CredentialVersion }
  | { readonly outcome: 'version_conflict' }
  | { readonly outcome: 'write_unverified' };

/**
 * `decideRebind` — pure. Refuses unless: the consent signature verifies under
 * the pinned consent key; `consent.bindingsDigest === digestBindings(next)`;
 * the consent is fresh; for a user-owned account the consenting user is the
 * owner in the plane's STORED `ownerRef` (so a tampered owner cannot consent
 * for itself); `stored.policyVersion === expectedVersion` and
 * `next.policyVersion > expectedVersion`; `tenantId` and `kind` are unchanged.
 * G1b implements.
 */
export type DecideRebind = (input: {
  readonly stored: PlaneBindings | null;
  readonly expectedVersion: PolicyVersion;
  readonly next: PlaneBindings;
  readonly consent: OwnerConsent;
  readonly consentPublicKey: Uint8Array;
  readonly now: number;
  readonly maxAgeMs: StoreLimits['rebindConsentMaxAgeMs'];
  readonly verify: Ed25519Verify;
  readonly hash: HashBytes;
}) => { readonly outcome: 'rebind' } | { readonly outcome: 'refuse'; readonly reason: Exclude<RebindResult, { readonly ok: true }>['reason'] };

/** The facts `describe` would return plus revocation state — what `decideResolve` compares against. */
export type StoredSecretFacts = {
  readonly kind: AccountKind;
  readonly currentVersion: CredentialVersion;
  readonly previousVersion: CredentialVersion | null;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
  readonly bindings: PlaneBindings;
};

export type ResolveDecision = { readonly ok: true } | { readonly ok: false; readonly reason: ResolveDenyReason };

/**
 * `digestPlaneScope` — SHA3-256 over `canonicalJson(scope)` with
 * `boundAgentPageIds` and `allowedOrigins` sorted, so the authority (reading
 * the main DB) and the plane (holding its own copy) derive the same bytes.
 * The injected `hash` MUST be SHA3-256. G1b implements.
 */
export type DigestPlaneScope = (input: { readonly scope: PlaneScope; readonly hash: HashBytes }) => PolicyDigest;

/** `digestBindings` — `hash(canonicalJson(bindings))`, the same bytes on the authority and the store side. G1b implements. */
export type DigestBindings = (input: { readonly bindings: PlaneBindings; readonly hash: HashBytes }) => BindingDigest;

/**
 * `decideResolve` — every refusal in ADR 0005 §8 F1–F5, F10 as data. The
 * bindings check is `digestBindings(stored.bindings) === grant.bindingDigest`
 * (constant-time), so the comparison needs no main-DB fact. G1b implements.
 */
export type DecideResolve = (input: {
  readonly grant: VerifiedGrant;
  readonly ref: SecretRef;
  readonly stored: StoredSecretFacts | null;
  readonly now: number;
  readonly rotationGraceMs: StoreLimits['rotationGraceMs'];
  readonly hash: HashBytes;
}) => ResolveDecision;
