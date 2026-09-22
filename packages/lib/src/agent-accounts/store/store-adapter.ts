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
import type { AgentPageId, BindingDigest, Brand, ConsentId, Ed25519Verify, HashBytes, PresenterChannel, UserId, VerifiedGrant } from '../grant';
import type { CanonicalOrigin, ResourceRestrictions } from '../canonical-request';
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
 * account, the allowed and auxiliary origins, the `session_http` flag and the
 * provider slug that selects the operation catalogue (ADR 0005 §2.4).
 * Delegation and approval rows are deliberately NOT here: each is protected
 * by its own fact compared against the signed grant (`DelegationFact`,
 * `ApprovalFact`).
 *
 * AMENDED 2026-09-16 (G1c R1/R7). The first scope left out
 * `sessionHttpEnabled`, `auxiliaryOrigins` and `providerSlug`. H1's premise is
 * that a main-DB writer leaves `policyVersion` alone, so a writer could turn
 * `sessionHttpEnabled` on (the authority then signs `sessionHttp: true`),
 * add an auxiliary origin, or switch `providerSlug` to a catalogue with
 * looser classes, and the plane's digest still matched.
 */
export type PlaneScope = {
  readonly approvalPolicy: AccountApprovalPolicy | null;
  readonly resourceRestrictions: ResourceRestrictions;
  /** Unrevoked `agent_account_bindings` plus the owner page of an agent-page-owned account; sorted before hashing. */
  readonly boundAgentPageIds: readonly AgentPageId[];
  readonly allowedOrigins: readonly CanonicalOrigin[];
  /** Human-approved at capture (S3 §3.5); sorted before hashing. */
  readonly auxiliaryOrigins: readonly CanonicalOrigin[];
  /** `agent_accounts.sessionHttpEnabled`: whether a `session` kind may reach the HTTP executor at all. */
  readonly sessionHttpEnabled: boolean;
  /** `agent_accounts.providerSlug`: selects the operation registry entries; null = generic origin (no entry matches). */
  readonly providerSlug: string | null;
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

/**
 * Which role a store identity was provisioned for. The four presenter
 * channels resolve; `ingress` is the write-only identity the credential-ingress
 * handler uses for `put`; `manage` is the authority's management worker, the
 * only role that may `rebind`, `revoke` or `describe` (ADR 0005 §2.1, F18).
 */
export type StoreChannel = PresenterChannel | 'ingress' | 'manage';

/**
 * The tenant-scoped machine identity handle a caller holds. A parameter so a
 * wrong-tenant identity is testable.
 *
 * AMENDED 2026-09-16 (G1c R8/E3). `channel` is a RUNTIME fact, not only a
 * type: `decideResolve` refuses when it differs from `grant.aud`, and the
 * adapter's `rebind`, `revoke` and `describe` refuse unless it is `manage`.
 * The first shape expressed both only in types, so a value assembled at
 * runtime (or cast) went unchecked.
 */
export type StoreIdentity = {
  readonly tenantId: TenantId;
  readonly identityId: string;
  readonly channel: StoreChannel;
  /** Per D-29's chosen model; reported so the audit can state the blast radius. */
  readonly blastRadius: 'tenant' | 'tier' | 'all';
};

/** Re-exported: the verifier's branded output (`grant.ts`, G1c R9). */
export type { VerifiedGrant };

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/**
 * `unknown` when `A` is ONE literal channel; otherwise a required property of
 * type `never`, which no argument can satisfy. Intersected into `resolve`'s
 * input so `ResolvableBy<A>` and `MaterialForChannel<A, K>` are only ever
 * computed from a literal audience: an unnarrowed grant would widen them to
 * every kind and to the refresh token (G1a review H6).
 */
export type NarrowedAudience<A extends PresenterChannel> = [A] extends [UnionToIntersection<A>]
  ? unknown
  : { readonly __narrowGrantAudienceBeforeResolve: never };

/**
 * Who may consent to a `rebind` of an account, PINNED in the plane at the
 * first `put` (G1c R2). A user-owned account's only consenter is the owner in
 * the stored `ownerRef`. An agent-page-owned account's consenters are the
 * humans pinned at put (the drive OWNER/ADMIN set the authority read then);
 * changing that set is itself a rebind that needs a CURRENT pinned consenter.
 * Main-DB drive roles never mint consent authority: a writer who makes
 * themselves ADMIN is not in the plane's set.
 */
export type PlaneConsenters =
  | { readonly kind: 'owner' }
  | { readonly kind: 'pinned'; readonly userIds: readonly UserId[] };

/**
 * The plane's own row for an account's bindings (G1c R4): separate from the
 * secret's version row, with CAS on `bindings.policyVersion`. A rebind writes
 * only this row, so it never changes `secret.version` or `credentialVersion`.
 * `scope` is kept beside `bindings` (its digest is `bindings.policyDigest`) so
 * the plane can tell a narrowing rebind from a widening one (R13).
 */
export type PlaneBindingsRecord = {
  readonly bindings: PlaneBindings;
  readonly scope: PlaneScope;
  readonly consenters: PlaneConsenters;
};

export type PutInput = {
  readonly ref: SecretRef;
  readonly material: SecretMaterial;
  /** null = create; otherwise the version the caller last observed (CAS). */
  readonly expectedVersion: CredentialVersion | null;
  readonly bindings: PlaneBindings;
  /** `digestPlaneScope(scope)` must equal `bindings.policyDigest`. Pinned beside the bindings on the first put; must equal the stored scope afterwards. */
  readonly scope: PlaneScope;
  /** `owner` iff `bindings.ownerRef.kind === 'user'`; a non-empty `pinned` set iff `agent_page`. Pinned on the first put; must equal the stored set afterwards. */
  readonly consenters: PlaneConsenters;
  /** The write-only credential-ingress identity (ADR 0005 §2.1); any other channel is `identity_refused` at runtime (G1c review). */
  readonly identity: StoreIdentity & { readonly channel: 'ingress' };
};

export type PutResult =
  | { readonly ok: true; readonly version: CredentialVersion }
  | {
      readonly ok: false;
      readonly reason: 'version_conflict' | 'write_unverified' | 'lock_unavailable' | 'store_unavailable' | 'kind_mismatch' | 'consenters_invalid' | 'identity_refused';
    };

export type ResolveInput<C extends PresenterChannel, K extends ResolvableBy<C> = ResolvableBy<C>> = {
  readonly ref: SecretRef & { readonly kind: K };
  readonly version: CredentialVersion;
  readonly grant: VerifiedGrant<C>;
  /** The caller's own channel must equal `grant.aud` — typed here and re-checked by `decideResolve` (R8). */
  readonly identity: StoreIdentity & { readonly channel: C };
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
  readonly grant: VerifiedGrant<'http-executor'> & { readonly sessionHttp: true };
  readonly identity: StoreIdentity & { readonly channel: 'http-executor' };
};

export type ResolveDenyReason =
  | 'version_mismatch'
  /**
   * The grant was signed under bindings OLDER than the plane's: its
   * `policyVersion` is below the stored `bindings.policyVersion` (a rebind
   * landed since issuance). Distinct from `binding_mismatch`, which means the
   * bindings disagree at the same or a newer epoch — the tampering signal
   * (G1c H2).
   */
  | 'bindings_stale'
  | 'binding_mismatch'
  | 'kind_not_resolvable'
  /** The identity's `channel` is not `grant.aud` (R8). */
  | 'identity_refused'
  | 'revoked'
  | 'not_found'
  /** Includes a ref in the reconcile-required state that could not be reconciled (E1): the ambiguous version is never served. */
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
 * An authenticated owner consent to a binding change: a human the plane
 * PINNED as a consenter (`PlaneConsenters`) passed step-up
 * (`auth/step-up-decisions.ts`) for EXACTLY this ref, these bindings and this
 * consenter set. Signed by the authority's step-up consent key (distinct from
 * the grant key) so the plane verifies it without reading the main DB; a DB
 * writer cannot mint one.
 *
 * AMENDED 2026-09-16 (G1c E2). The first consent bound only a bindings digest.
 * `PlaneBindings` names no account, so a consent for account A replayed onto
 * account B with identical bindings verified, and nothing recorded
 * `consentId`, so the same consent could be applied again inside its max age.
 * It now names the `ref` and is consumed single-use by `consentId` through the
 * shared replay store before the rebind is written.
 */
export type OwnerConsent = {
  readonly consentId: ConsentId;
  readonly consentingUserId: UserId;
  readonly stepUpChallengeId: string;
  readonly ref: SecretRef;
  /** `digestBindings` over the bindings being written — consent is to these bytes, not to "a change". */
  readonly bindingsDigest: BindingDigest;
  /** The consenter set being written (unchanged or not): changing who may consent is itself consented to. */
  readonly consenters: PlaneConsenters;
  /** ms since epoch; the plane refuses a consent older than `StoreLimits['rebindConsentMaxAgeMs']`. */
  readonly issuedAt: number;
  /** Base64 Ed25519 over the canonical JSON of the fields above. */
  readonly signature: string;
};

/**
 * `rebind` — the ONE path that rewrites the plane's bindings row without
 * touching material or `secret.version`: a `policyVersion` bump (membership,
 * instructions, copy, move), a narrowing, or a widening (origins, policy,
 * restrictions, agent bindings, `session_http`, provider). CAS on the stored
 * `policyVersion`. Callable only by a `manage` identity — held by the
 * authority's management worker, never by `apps/web`.
 *
 * Consent (G1c R13): a rebind whose `scope` equals or is strictly narrower
 * than the stored one, with owner, tenant, kind and consenters unchanged,
 * needs NO consent — a bump caused by someone who is not a consenter (an admin
 * removing the owner's membership, the owner deleted) must still be writable,
 * or every grant stays `bindings_stale` forever. Any widening, and any change
 * to the consenter set, needs an `OwnerConsent` from a CURRENT pinned
 * consenter (R2).
 */
export type RebindInput = {
  readonly ref: SecretRef;
  /** The `policyVersion` of the bindings the caller last observed in the plane (CAS). */
  readonly expectedVersion: PolicyVersion;
  /** `bindings.policyVersion` must be strictly greater than `expectedVersion`; tenant, kind and owner kind must be unchanged. */
  readonly bindings: PlaneBindings;
  /** `digestPlaneScope(scope)` must equal `bindings.policyDigest`. */
  readonly scope: PlaneScope;
  readonly consenters: PlaneConsenters;
  /** null only for an equal-or-narrower rebind (R13). */
  readonly consent: OwnerConsent | null;
  readonly identity: StoreIdentity & { readonly channel: 'manage' };
};

export type RebindResult =
  | { readonly ok: true; readonly policyVersion: PolicyVersion }
  | {
      readonly ok: false;
      readonly reason:
        | 'version_conflict'
        | 'consent_required'
        | 'consent_invalid'
        /** The ref is revoked: its bindings are never rewritten and no consent is spent on it (G1c review). */
        | 'revoked'
        | 'immutable_binding_changed'
        | 'identity_refused'
        | 'write_unverified'
        | 'lock_unavailable'
        | 'store_unavailable'
        | 'not_found';
    };

export type RevokeReason = 'owner_revoked' | 'policy_revoked' | 'rotation_replay' | 'erasure' | 'admin';

export type RevokeInput = { readonly ref: SecretRef; readonly reason: RevokeReason; readonly identity: StoreIdentity & { readonly channel: 'manage' } };
export type RevokeResult =
  | { readonly ok: true; readonly revokedAt: number }
  | { readonly ok: false; readonly reason: 'not_found' | 'identity_refused' | 'store_unavailable' };

/** What happened at the PROVIDER when we tried to revoke there. Reported, never inferred. */
export type UpstreamRevocation = 'revoked' | 'unsupported' | 'failed' | 'not_attempted';

export type DeleteInput = { readonly ref: SecretRef; readonly identity: StoreIdentity & { readonly channel: 'manage' }; readonly upstream: UpstreamRevocation };
export type DeleteResult =
  | { readonly ok: true; readonly removed: true; readonly upstream: UpstreamRevocation }
  | { readonly ok: false; readonly reason: 'not_found' | 'identity_refused' | 'store_unavailable' };

export type DescribeInput = { readonly ref: SecretRef; readonly identity: StoreIdentity & { readonly channel: 'manage' } };
/**
 * Metadata only, never material. `previousVersion` and `rotatedAt` are the
 * PLANE-ATTESTED rotation facts the verifier consumes as
 * `ExpectedBinding.previousCredentialVersion` / `rotatedAt` (ADR 0004 F5a):
 * they come from the plane's own metadata store, never from a main-DB row
 * (G1c R3 + M7 attestation).
 */
export type DescribeResult =
  | {
      readonly ok: true;
      readonly kind: AccountKind;
      readonly version: CredentialVersion;
      readonly previousVersion: CredentialVersion | null;
      readonly bindings: PlaneBindings;
      readonly consenters: PlaneConsenters;
      readonly createdAt: number;
      readonly rotatedAt: number | null;
      readonly revokedAt: number | null;
    }
  | { readonly ok: false; readonly reason: 'not_found' | 'identity_refused' | 'store_unavailable' };

/** The interface (ADR 0005 §2.2). Executors are the only `resolve` callers; the web process never holds a reading identity. */
export type StoreAdapter = {
  readonly put: (input: PutInput) => Promise<PutResult>;
  /** Accepts only a grant narrowed to ONE audience (`NarrowedAudience`); an unnarrowed `VerifiedGrant` does not compile. */
  readonly resolve: <C extends PresenterChannel, K extends ResolvableBy<C>>(
    input: ResolveInput<C, K> & NarrowedAudience<C>,
  ) => Promise<ResolveResult<C, K>>;
  /** See `SessionHttpResolveInput`; unrepresentable without `grant.sessionHttp: true`. */
  readonly resolveSessionOverHttp: (input: SessionHttpResolveInput) => Promise<ResolveResult<'http-executor', 'session'>>;
  readonly rotate: (input: RotateInput) => Promise<RotateResult>;
  /** Manage identity; owner consent unless the rebind narrows; see `RebindInput`. */
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
 * `decideRebind` — pure. Refuses unless: something is stored (`not_found`);
 * `digestPlaneScope(next.scope) === next.bindings.policyDigest`;
 * `tenantId`, `kind` and `ownerRef.kind` are unchanged and the owner still
 * derives the stored tenant (`immutable_binding_changed`, R2);
 * `stored.bindings.policyVersion === expectedVersion` and
 * `next.bindings.policyVersion > expectedVersion` (`version_conflict`). Then
 * consent: an equal-or-narrower scope with unchanged owner and consenters needs
 * none (R13); anything else needs a consent (`consent_required`) whose
 * signature verifies under the pinned consent key, whose `ref` is this ref,
 * whose `bindingsDigest` and `consenters` are exactly `next`, which is fresh,
 * and whose consenting user is a consenter in the STORED record — the stored
 * user owner, or a member of the stored pinned set (`consent_invalid`, R2/E2).
 * A `rebind` verdict names the consent the adapter must consume single-use
 * BEFORE writing (`consumeConsentId`, null when none was needed).
 */
export type DecideRebind = (input: {
  readonly ref: SecretRef;
  readonly stored: PlaneBindingsRecord | null;
  /** Whether the plane records a revocation for the ref; a revoked ref is refused before anything else is checked. */
  readonly storedRevoked: boolean;
  readonly expectedVersion: PolicyVersion;
  readonly next: PlaneBindingsRecord;
  readonly consent: OwnerConsent | null;
  readonly consentPublicKey: Uint8Array;
  readonly now: number;
  readonly maxAgeMs: StoreLimits['rebindConsentMaxAgeMs'];
  readonly verify: Ed25519Verify;
  readonly hash: HashBytes;
}) =>
  | { readonly outcome: 'rebind'; readonly consumeConsentId: ConsentId | null }
  | { readonly outcome: 'refuse'; readonly reason: Exclude<RebindResult, { readonly ok: true }>['reason'] };

/**
 * `isScopeNarrowing` — pure (R13). True iff `next` authorizes nothing `stored`
 * does not: every origin list and the bound agent pages are subsets; each
 * stored resource restriction key survives with a subset of its values (a new
 * key only narrows); `sessionHttpEnabled` is not turned on; `providerSlug` is
 * unchanged; and the approval policy is null (every use asks), or both are
 * non-null with a subset scope, a trigger that asks for at least as many
 * classes, an end no later, limits no higher and the same approver. Equal
 * scopes are narrowing.
 */
export type IsScopeNarrowing = (input: { readonly stored: PlaneScope; readonly next: PlaneScope }) => boolean;

/**
 * The uncertain-write marker (G1c E1). Recorded in the plane metadata row,
 * under the advisory lock, BEFORE the Infisical write of a replacing
 * put/rotate; cleared by the metadata commit. A row still carrying one is
 * reconcile-required: the Infisical write may have landed while the commit
 * failed. `digest` is `digestWrite` of the attempted value+comment and exists
 * only while the write is ambiguous.
 */
export type PendingWrite = {
  readonly version: CredentialVersion;
  readonly digest: WriteDigest;
  /** `true` when the attempted write was a `rotate` (it opens grace on commit). */
  readonly rotation: boolean;
};

/**
 * HMAC-SHA3-256 under the plane-held `WriteDigestKey` over
 * `canonicalJson({ secretValue, secretComment })` of one Infisical write.
 *
 * AMENDED 2026-09-21 (G2 ruling 4). The first digest was an unkeyed hash, so a
 * reader of the plane metadata row could recover the material from a known
 * candidate set (a leaked key list, a key format with a short random tail).
 */
export type WriteDigest = Brand<string, 'WriteDigest'>;

/**
 * The plane-held HMAC key for `WriteDigest` (G2 ruling 4). Lives only in the
 * credential plane's own process environment — never in the main DB, never in
 * the web process — and is at least 32 bytes (`parseWriteDigestKey`).
 */
export type WriteDigestKey = Brand<Uint8Array, 'WriteDigestKey'>;

/** Injected keyed MAC (HMAC-SHA3-256 in production), so pure modules never touch `node:crypto`. */
export type HmacBytes = (key: Uint8Array, bytes: Uint8Array) => string;

export type DigestWrite = (input: {
  readonly secretValue: string;
  readonly secretComment: string;
  readonly key: WriteDigestKey;
  readonly hmac: HmacBytes;
}) => WriteDigest;

/**
 * `decideReconcile` — pure (E1). The next adapter call on a reconcile-required
 * ref reads Infisical's current version and write digest under the advisory
 * lock and hands them here: `commit_forward` only when they are exactly the
 * pending write; `abort_pending` when Infisical still holds the version the
 * plane last committed (`current`) — every Infisical write creates a new
 * version, so the replacing write provably did not land and the ref returns
 * to service (G2 ruling E1(b)); otherwise `fail_closed` (the ref stays
 * reconcile-required and nothing is served or written).
 */
export type DecideReconcile = (input: {
  readonly pending: PendingWrite;
  /** The plane's committed `currentVersion` — the version the pending write was replacing. */
  readonly current: CredentialVersion;
  readonly observed: { readonly version: CredentialVersion; readonly digest: WriteDigest } | null;
}) =>
  | { readonly outcome: 'commit_forward'; readonly version: CredentialVersion }
  | { readonly outcome: 'abort_pending' }
  | { readonly outcome: 'fail_closed' };

/**
 * Why a replacing Infisical write returned no version. `not_sent`: the adapter
 * knows the request never left the process (login failed, request could not
 * be built). Every other failure leaves the outcome unknown.
 */
export type WriteFailure = 'not_sent' | 'not_found' | 'unavailable';

/**
 * `decidePendingOnWriteFailure` — pure (G2 ruling E1(a)). A write that was
 * never sent cannot have landed, so its marker is aborted in the same locked
 * section; any other failure keeps it for `decideReconcile`.
 */
export type DecidePendingOnWriteFailure = (input: { readonly failure: WriteFailure }) => { readonly action: 'abort_pending' } | { readonly action: 'keep_pending' };

/**
 * `decideOrphanAdoption` — pure (E1). A first put (no metadata row) that finds
 * the key already in Infisical — material from an earlier first put whose
 * commit failed — adopts it only when the orphan is exactly this put's
 * attempted write; otherwise the orphan is erased before the put proceeds.
 */
export type DecideOrphanAdoption = (input: {
  readonly attempted: WriteDigest;
  readonly observed: { readonly version: CredentialVersion; readonly digest: WriteDigest };
}) => { readonly outcome: 'adopt'; readonly version: CredentialVersion } | { readonly outcome: 'erase' };

/**
 * `decideStoreCaller` — pure (R8/E3). Whether an identity may perform an
 * operation that requires one role (`manage` for rebind, revoke, describe):
 * same tenant as the ref and exactly that channel.
 */
export type DecideStoreCaller = (input: {
  readonly identity: StoreIdentity;
  readonly ref: SecretRef;
  readonly required: StoreChannel;
}) => { readonly ok: true } | { readonly ok: false; readonly reason: 'not_found' | 'identity_refused' };

/** The facts `describe` would return plus revocation and reconcile state — what `decideResolve` compares against. */
export type StoredSecretFacts = {
  readonly kind: AccountKind;
  readonly currentVersion: CredentialVersion;
  readonly previousVersion: CredentialVersion | null;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
  /** From the bindings row (R4). */
  readonly bindings: PlaneBindings;
  /** Non-null = reconcile-required (E1); `decideResolve` refuses `store_unavailable`. */
  readonly pendingWrite: PendingWrite | null;
};

export type ResolveDecision = { readonly ok: true } | { readonly ok: false; readonly reason: ResolveDenyReason };

/**
 * `digestPlaneScope` — SHA3-256 over `canonicalJson(scope)` with
 * `boundAgentPageIds`, `allowedOrigins` and `auxiliaryOrigins` sorted, so the authority (reading
 * the main DB) and the plane (holding its own copy) derive the same bytes.
 * The injected `hash` MUST be SHA3-256. G1b implements.
 */
export type DigestPlaneScope = (input: { readonly scope: PlaneScope; readonly hash: HashBytes }) => PolicyDigest;

/** `digestBindings` — `hash(canonicalJson(bindings))`, the same bytes on the authority and the store side. G1b implements. */
export type DigestBindings = (input: { readonly bindings: PlaneBindings; readonly hash: HashBytes }) => BindingDigest;

/**
 * `decideResolve` — every refusal in ADR 0005 §8 F1–F5, F10 as data. The
 * identity's `channel` must be `grant.aud` (`identity_refused`, R8); a
 * reconcile-required ref is `store_unavailable` (E1); a grant whose
 * `policyVersion` is below the stored bindings' is `bindings_stale` (H2);
 * otherwise the bindings check is `digestBindings(stored.bindings) ===
 * grant.bindingDigest` (constant-time), so the comparison needs no main-DB
 * fact.
 */
export type DecideResolve = (input: {
  readonly grant: VerifiedGrant;
  readonly identity: StoreIdentity;
  readonly ref: SecretRef;
  readonly stored: StoredSecretFacts | null;
  readonly now: number;
  readonly rotationGraceMs: StoreLimits['rotationGraceMs'];
  readonly hash: HashBytes;
}) => ResolveDecision;
