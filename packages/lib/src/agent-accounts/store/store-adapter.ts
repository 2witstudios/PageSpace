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
import type { AgentAccountGrant, ExecutorChannel, PresenterChannel } from '../grant';
import type { CanonicalOrigin } from '../canonical-request';

/** Maps to the Infisical path `/<tenantProject>/<accountId>/<kind>`. */
export type SecretRef = {
  readonly tenantId: TenantId;
  readonly accountId: AccountId;
  readonly kind: AccountKind;
};

/**
 * The plane's INDEPENDENT copy of the authority bindings, stored beside the
 * material and compared at resolve (threat model A9: a main-DB writer who
 * reassigns owner/origins produces a grant whose bindings disagree here).
 */
export type PlaneBindings = {
  readonly tenantId: TenantId;
  readonly ownerRef: AccountOwnerRef;
  readonly allowedOrigins: readonly CanonicalOrigin[];
  readonly policyVersion: PolicyVersion;
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
 * Which kinds each channel may resolve (ADR 0005 §4.2). `password` is the
 * browser-fill executor's alone; the HTTP executor's type excludes it, so a
 * call site that tries does not compile (mutation pair required at G1b).
 */
export type ResolvableBy<C extends PresenterChannel> = {
  readonly 'http-executor': 'api_key' | 'bearer' | 'oauth2' | 'session';
  readonly 'relay-runner': 'api_key' | 'bearer' | 'oauth2';
  readonly 'browser-worker': 'session' | 'password';
  readonly 'refresh-worker': 'oauth2';
}[C];

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

export type ResolveInput<C extends ExecutorChannel | 'refresh-worker'> = {
  readonly ref: SecretRef & { readonly kind: ResolvableBy<C> };
  readonly version: CredentialVersion;
  readonly grant: VerifiedGrant & { readonly aud: C };
  readonly identity: StoreIdentity;
};

export type ResolveDenyReason =
  | 'version_mismatch'
  | 'binding_mismatch'
  | 'kind_not_resolvable'
  | 'revoked'
  | 'not_found'
  | 'store_unavailable';

export type ResolveResult<K extends AccountKind> =
  | { readonly ok: true; readonly material: Extract<SecretMaterial, { readonly kind: K }>; readonly version: CredentialVersion }
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
  readonly resolve: <C extends ExecutorChannel | 'refresh-worker'>(input: ResolveInput<C>) => Promise<ResolveResult<ResolvableBy<C>>>;
  readonly rotate: (input: RotateInput) => Promise<RotateResult>;
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

/** `decideResolve` — every refusal in ADR 0005 §8 F1–F5, F10 as data. G1b implements. */
export type DecideResolve = (input: {
  readonly grant: VerifiedGrant;
  readonly ref: SecretRef;
  readonly stored: StoredSecretFacts | null;
  readonly now: number;
  readonly rotationGraceMs: StoreLimits['rotationGraceMs'];
}) => ResolveDecision;
