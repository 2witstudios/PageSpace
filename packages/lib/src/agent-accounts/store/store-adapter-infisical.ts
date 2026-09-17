/**
 * `createInfisicalStoreAdapter` — the `StoreAdapter` implementation against
 * self-hosted Infisical OSS (D-21 revised; ADR 0005 §2). I/O only: every
 * decision is a pure module (`decideCas`, `decideResolve`, `decideRebind`,
 * `decideWriteRecord`, `decideStoreCaller`, `decideReconcile`,
 * `decideOrphanAdoption`, `decideConsentConsumption`); this file reads, writes,
 * locks and calls them.
 *
 * NOT exported from any `packages/lib` `package.json` subpath — `resolve`
 * (and every other operation here) is reachable only by code inside
 * `packages/lib` that imports this file by its relative path, never by
 * `apps/web` through a public export (ADR 0005 §3.4, F13). A test proves
 * the export map has no entry naming this module.
 *
 * `resolveProject` and `resolveCredentials` are the provisioning/identity
 * I/O this adapter needs but does not own: a real deployment wires them to
 * a provisioning identity (project create/lookup) and a credential store
 * (Universal Auth client id/secret per `StoreIdentity.identityId`) — kept
 * as injected functions so this file never holds a root/admin token itself.
 * `consentLedger` is the shared replay store (`consent-ledger-repository.ts`).
 */
import type { AccountKind, CredentialVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { Ed25519Verify, HashBytes, PresenterChannel } from '../grant';
import type {
  DeleteInput,
  DeleteResult,
  DescribeInput,
  DescribeResult,
  MaterialForChannel,
  PlaneBindings,
  PlaneBindingsRecord,
  PlaneConsenters,
  PlaneScope,
  PutInput,
  PutResult,
  ResolvableBy,
  ResolveInput,
  ResolveResult,
  RebindInput,
  RebindResult,
  RevokeInput,
  RevokeResult,
  RotateInput,
  RotateResult,
  SecretMaterial,
  SecretMaterialByKind,
  SecretRef,
  SessionHttpResolveInput,
  StoreAdapter,
  StoreIdentity,
  StoreLimits,
} from './store-adapter';
import type { InfisicalClient, InfisicalCredentials } from './infisical-client';
import type { PlaneMetadataRepository, StoredPlaneFacts } from './plane-metadata-repository';
import type { ConsentLedger } from './consent-ledger-repository';
import { lockKeyFor } from './plane-metadata-repository';
import { canonicalJson } from '../canonical-json';
import { decideCas } from './decide-cas';
import { decideConsentConsumption } from './decide-consent-consumption';
import { decideOrphanAdoption } from './decide-orphan-adoption';
import { decideRebind } from './decide-rebind';
import { decideReconcile } from './decide-reconcile';
import { decideResolve } from './decide-resolve';
import { decideStoreCaller } from './decide-store-caller';
import { decideWriteRecord } from './decide-write-record';
import { digestWrite } from './digest-write';
import { withAdvisoryLock, type AdvisoryLockPool, type WithAdvisoryLockResult } from '@pagespace/db/advisory-lock';

export type ResolveProject = (tenantId: TenantId) => Promise<{ readonly projectId: string } | null>;
export type ResolveCredentials = (input: { readonly tenantId: TenantId; readonly identityId: string }) => Promise<InfisicalCredentials | null>;

export type StoreAdapterInfisicalDeps = {
  readonly infisical: InfisicalClient;
  readonly metadata: PlaneMetadataRepository;
  readonly advisoryLockPool: AdvisoryLockPool;
  readonly resolveProject: ResolveProject;
  readonly resolveCredentials: ResolveCredentials;
  readonly hash: HashBytes;
  readonly now: () => number;
  readonly rotationGraceMs?: number;
  /** The authority's step-up consent public key (DER SPKI) — distinct from the grant key; `rebind` verifies under it. */
  readonly consentPublicKey: Uint8Array;
  readonly verify: Ed25519Verify;
  /** Single-use consumption of `OwnerConsent.consentId` through the shared replay store (G1c E2). */
  readonly consentLedger: ConsentLedger;
};

const ROTATION_GRACE_MS_DEFAULT = 300_000;
const REBIND_CONSENT_MAX_AGE_MS: StoreLimits['rebindConsentMaxAgeMs'] = 300_000;
/**
 * `withAdvisoryLock` (packages/db) is a TRY lock — a competitor mid-write
 * gets `lock_busy` immediately rather than waiting. A bounded retry turns
 * that into real serialization: the loser waits for the winner to finish,
 * then re-reads under its OWN lock acquisition and sees the bumped version,
 * so two concurrent writers with the same `expectedVersion` resolve to
 * exactly one `commit` and one genuine `version_conflict` (ADR 0005 §10.8),
 * never a spurious `lock_unavailable`.
 */
// ~5s: a winning write makes several Infisical calls, each with its own Universal Auth login, so a
// ~1s budget turned an honest serialization into a spurious lock_unavailable under load.
const LOCK_RETRY_ATTEMPTS = 200;
const LOCK_RETRY_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secretKeyFor(accountId: string, kind: AccountKind): string {
  return `${accountId}__${kind}`;
}

/**
 * The rotation-grace companion secret: a snapshot of the material `rotate`
 * is about to replace, so a grant that named the OLD version can still be
 * served real material inside `rotationGraceMs` (ADR 0005 §2.2 `rotate`).
 * Self-hosted Infisical OSS exposes no secret-version-history read API (the
 * `/api/v1/secret/{id}/secret-versions` route returned 403 against a fresh
 * instance, consistent with point-in-time recovery being a paid-tier
 * feature) — this is the OSS-compatible substitute: the grace copy lives in
 * Infisical too (never our metadata DB, which holds no secret material),
 * tagged with the version it represents so a resolve can verify freshness.
 */
function previousSecretKeyFor(accountId: string, kind: AccountKind): string {
  return `${accountId}__${kind}__previous`;
}

type PreviousSnapshotComment = { readonly __version: number };

/**
 * Plane metadata I/O (a Postgres the adapter does not control) can reject during an outage. Every
 * operation's contract has a `store_unavailable` outcome for exactly that, so a rejection is turned
 * into this marker at each call site and reported as data — never a throw an executor sees as a 500
 * (Codex review PR #2646 P2).
 */
const METADATA_UNAVAILABLE = Symbol('metadata_unavailable');

async function metadataCall<T>(call: () => Promise<T>): Promise<T | typeof METADATA_UNAVAILABLE> {
  try {
    return await call();
  } catch {
    return METADATA_UNAVAILABLE;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stripRefreshToken<K extends AccountKind>(kind: K, material: SecretMaterial['material'], aud: PresenterChannel): unknown {
  if (kind !== 'oauth2' || aud === 'refresh-worker') return material;
  const { refreshToken: _refreshToken, ...rest } = material as SecretMaterialByKind['oauth2'];
  return rest;
}

function recordOf(facts: StoredPlaneFacts): PlaneBindingsRecord {
  return { bindings: facts.bindings, scope: facts.scope, consenters: facts.consenters };
}

type TenantStore = { readonly projectId: string; readonly credentials: InfisicalCredentials };

export function createInfisicalStoreAdapter(deps: StoreAdapterInfisicalDeps): StoreAdapter {
  const rotationGraceMs = (deps.rotationGraceMs ?? ROTATION_GRACE_MS_DEFAULT) as StoreLimits['rotationGraceMs'];

  /** `withAdvisoryLock` on the ref's key, retried while busy (see LOCK_RETRY_ATTEMPTS). */
  async function withSecretLock<T>(ref: SecretRef, fn: () => Promise<T>): Promise<WithAdvisoryLockResult<T>> {
    const attempt = () => withAdvisoryLock(deps.advisoryLockPool, lockKeyFor(ref), fn);
    let lockResult = await attempt();
    for (let tries = 0; lockResult.outcome === 'lock_busy' && tries < LOCK_RETRY_ATTEMPTS; tries += 1) {
      await sleep(LOCK_RETRY_DELAY_MS);
      lockResult = await attempt();
    }
    return lockResult;
  }

  /**
   * The injected provisioning lookups (project, Universal Auth credentials) are I/O this adapter does
   * not own; a lookup that throws is a store outage, reported as `null` like a missing project.
   */
  async function lookupStore(tenantId: TenantId, identityId: string): Promise<TenantStore | null> {
    try {
      const project = await deps.resolveProject(tenantId);
      const credentials = await deps.resolveCredentials({ tenantId, identityId });
      return project === null || credentials === null ? null : { projectId: project.projectId, credentials };
    } catch {
      return null;
    }
  }

  /** The write digest Infisical currently holds under `secretKey`, or null when it cannot be read. */
  async function observeWrite(store: TenantStore, secretKey: string): Promise<{ readonly version: CredentialVersion; readonly digest: ReturnType<typeof digestWrite> } | null> {
    const got = await deps.infisical.getSecret({ projectId: store.projectId, credentials: store.credentials, secretKey });
    if (!got.ok) return null;
    return { version: got.secret.version as CredentialVersion, digest: digestWrite({ secretValue: got.secret.secretValue, secretComment: got.secret.secretComment, hash: deps.hash }) };
  }

  /**
   * G1c E1 — CALLER HOLDS THE LOCK. A row carrying a pending write is reconcile-required: read what
   * Infisical holds and let `decideReconcile` either commit the metadata forward to exactly that
   * write or fail closed (the row stays pending; nothing is served or written).
   */
  async function reconcileLocked(ref: SecretRef, facts: StoredPlaneFacts, store: TenantStore): Promise<StoredPlaneFacts | 'fail_closed' | typeof METADATA_UNAVAILABLE> {
    if (facts.pendingWrite === null) return facts;
    const observed = await observeWrite(store, secretKeyFor(ref.accountId, ref.kind));
    const decision = decideReconcile({ pending: facts.pendingWrite, observed });
    if (decision.outcome === 'fail_closed') return 'fail_closed';
    const moved = await metadataCall(() => deps.metadata.commitForward({ ref, pending: facts.pendingWrite!, rotatedAt: deps.now() }));
    if (moved === METADATA_UNAVAILABLE) return METADATA_UNAVAILABLE;
    if (!moved) return 'fail_closed';
    const after = await metadataCall(() => deps.metadata.read(ref));
    if (after === METADATA_UNAVAILABLE) return METADATA_UNAVAILABLE;
    return after === null ? 'fail_closed' : after;
  }

  /**
   * Read a ref's facts for a non-writing operation, reconciling a pending write under the lock first
   * (G1c E1: the next call on the ref reconciles). A pending write that cannot be reconciled is
   * returned as it stands, so the decision that follows refuses on it.
   */
  async function readReconciled(ref: SecretRef, identityId: string): Promise<StoredPlaneFacts | null | typeof METADATA_UNAVAILABLE> {
    const facts = await metadataCall(() => deps.metadata.read(ref));
    if (facts === METADATA_UNAVAILABLE || facts === null || facts.pendingWrite === null) return facts;
    const store = await lookupStore(ref.tenantId, identityId);
    if (store === null) return facts;
    const locked = await withSecretLock(ref, async () => {
      const current = await metadataCall(() => deps.metadata.read(ref));
      if (current === METADATA_UNAVAILABLE || current === null) return current;
      const reconciled = await reconcileLocked(ref, current, store);
      return reconciled === 'fail_closed' ? current : reconciled;
    });
    return locked.outcome === 'acquired' ? locked.result : facts;
  }

  async function writeSecret(input: {
    readonly ref: SecretRef;
    readonly material: SecretMaterial;
    readonly expectedVersion: CredentialVersion | null;
    readonly bindings: PlaneBindings;
    /** `put` carries the record to pin or match; `rotate` carries only bindings and inherits the stored scope and consenters. */
    readonly scope: PlaneScope | null;
    readonly consenters: PlaneConsenters | null;
    readonly identity: StoreIdentity;
    /** Only `rotate` sets this — snapshot the material being replaced for grace resolves. */
    readonly rotation: boolean;
  }): Promise<PutResult> {
    const { ref, material, expectedVersion, bindings, identity, rotation } = input;
    if (ref.tenantId !== identity.tenantId) return { ok: false, reason: 'store_unavailable' };
    // G1c review: the role is checked at runtime here too — ingress puts, only the refresh worker rotates.
    if (!decideStoreCaller({ identity, ref, required: rotation ? 'refresh-worker' : 'ingress' }).ok) return { ok: false, reason: 'identity_refused' };
    // PutInput does not type-correlate ref.kind with SecretMaterial's discriminant — a caller
    // could otherwise submit e.g. password material under an api_key ref (Codex review PR #2646
    // P2). Reject before any I/O.
    if (ref.kind !== material.kind) return { ok: false, reason: 'kind_mismatch' };
    // The bindings written must describe the ref they are written under.
    if (bindings.kind !== ref.kind) return { ok: false, reason: 'kind_mismatch' };
    if (bindings.tenantId !== ref.tenantId) return { ok: false, reason: 'store_unavailable' };

    const store = await lookupStore(ref.tenantId, identity.identityId);
    if (store === null) return { ok: false, reason: 'store_unavailable' };
    const { projectId, credentials } = store;

    const lockResult = await withSecretLock(ref, async (): Promise<PutResult | 'metadata_unavailable'> => {
      const read = await metadataCall(() => deps.metadata.read(ref));
      if (read === METADATA_UNAVAILABLE) return 'metadata_unavailable';
      // G1c E1: a ref left reconcile-required by a failed commit is reconciled before anything else.
      const reconciled = read === null ? null : await reconcileLocked(ref, read, store);
      if (reconciled === METADATA_UNAVAILABLE) return 'metadata_unavailable';
      if (reconciled === 'fail_closed') return { ok: false, reason: 'write_unverified' };
      const before = reconciled;
      // A revoked ref is broker-denied permanently, never reactivated by a later write (ADR 0005
      // §2.2 revoke: "every future resolve returns revoked"). Refuse under the SAME lock a write
      // would use, before touching Infisical or the metadata row (Codex review PR #2646 P1).
      if (before !== null && before.revokedAt !== null) return { ok: false, reason: 'write_unverified' };

      // G1c R2/R4: the write carries the whole bindings record — pinned on the first put, identical
      // (consenters included) afterwards. Only `rebind` rewrites it.
      const scope = input.scope ?? before?.scope ?? null;
      const consenters = input.consenters ?? before?.consenters ?? null;
      if (scope === null || consenters === null) return { ok: false, reason: 'version_conflict' };
      const written: PlaneBindingsRecord = { bindings, scope, consenters };
      const recordDecision = decideWriteRecord({ stored: before === null ? null : recordOf(before), written, hash: deps.hash });
      if (!recordDecision.ok) return { ok: false, reason: recordDecision.reason };

      const observedBefore = (before?.currentVersion ?? null) as CredentialVersion | null;
      const assumedNextVersion = ((observedBefore ?? 0) + 1) as CredentialVersion;
      const preCheck = decideCas({ expectedVersion, observedBefore, observedAfter: assumedNextVersion, bindingsAfter: bindings, bindingsWritten: bindings });
      if (preCheck.outcome === 'version_conflict') return { ok: false, reason: 'version_conflict' };

      const secretKey = secretKeyFor(ref.accountId, ref.kind);
      // `material` is the discriminated SecretMaterial wrapper ({ kind, material: perKindPayload });
      // store only the per-kind payload so resolve hands callers exactly the shape they expect
      // (Codex review PR #2646 P1).
      const secretValue = JSON.stringify({ kind: ref.kind, material: material.material });
      const secretComment = JSON.stringify(bindings);
      const attempted = digestWrite({ secretValue, secretComment, hash: deps.hash });

      if (before !== null) {
        // Snapshot the CURRENT material into the grace companion before it is overwritten, so a
        // grant that named `observedBefore` can still be served real material inside
        // `rotationGraceMs` (ADR 0005 §2.2; Codex review PR #2646 P1).
        if (rotation) {
          const current = await deps.infisical.getSecret({ projectId, credentials, secretKey });
          // The copy is labelled with the plane's version, so it must BE that version in Infisical (G1c review).
          if (!current.ok || current.secret.version !== observedBefore) return { ok: false, reason: 'write_unverified' };
          const previousKey = previousSecretKeyFor(ref.accountId, ref.kind);
          const previousComment: PreviousSnapshotComment = { __version: observedBefore as number };
          const previousWrite = await deps.infisical.getSecret({ projectId, credentials, secretKey: previousKey });
          const snapshotResult = previousWrite.ok
            ? await deps.infisical.updateSecret({ projectId, credentials, secretKey: previousKey, secretValue: current.secret.secretValue, secretComment: JSON.stringify(previousComment) })
            : await deps.infisical.createSecret({ projectId, credentials, secretKey: previousKey, secretValue: current.secret.secretValue, secretComment: JSON.stringify(previousComment) });
          if (!snapshotResult.ok) return { ok: false, reason: 'write_unverified' };
        }
        // G1c E1: the uncertain-write marker goes down BEFORE the replacing write, so a commit that
        // fails afterwards leaves the ref reconcile-required instead of silently diverged.
        const marked = await metadataCall(() => deps.metadata.markPending({ ref, pending: { version: assumedNextVersion, digest: attempted, rotation } }));
        if (marked === METADATA_UNAVAILABLE) return 'metadata_unavailable';
        if (!marked) return { ok: false, reason: 'write_unverified' };
        const updated = await deps.infisical.updateSecret({ projectId, credentials, secretKey, secretValue, secretComment });
        if (!updated.ok) return { ok: false, reason: 'write_unverified' };
      } else {
        const created = await deps.infisical.createSecret({ projectId, credentials, secretKey, secretValue, secretComment });
        if (!created.ok) {
          // G1c E1: a first put finding its key already in Infisical has met an orphan from an earlier
          // first put whose commit failed. Adopt it only if it is exactly this write; otherwise erase it.
          const orphan = await observeWrite(store, secretKey);
          if (orphan === null) return { ok: false, reason: 'write_unverified' };
          const adoption = decideOrphanAdoption({ attempted, observed: orphan });
          if (adoption.outcome === 'adopt') {
            const adopted = await metadataCall(() => deps.metadata.commit({ ref, version: adoption.version, previousVersion: null, rotatedAt: null, record: written }));
            return adopted === true ? { ok: true, version: adoption.version } : { ok: false, reason: 'write_unverified' };
          }
          const erased = await deps.infisical.deleteSecret({ projectId, credentials, secretKey });
          if (!erased.ok && erased.reason !== 'not_found') return { ok: false, reason: 'write_unverified' };
          const recreated = await deps.infisical.createSecret({ projectId, credentials, secretKey, secretValue, secretComment });
          if (!recreated.ok) return { ok: false, reason: 'write_unverified' };
        }
      }

      const verify = await deps.infisical.getSecret({ projectId, credentials, secretKey });
      if (!verify.ok) return { ok: false, reason: 'write_unverified' };

      let verifiedBindings: PlaneBindings;
      try {
        verifiedBindings = JSON.parse(verify.secret.secretComment) as PlaneBindings;
      } catch {
        return { ok: false, reason: 'write_unverified' };
      }

      const decision = decideCas({
        expectedVersion,
        observedBefore,
        observedAfter: verify.secret.version as CredentialVersion,
        bindingsAfter: verifiedBindings,
        bindingsWritten: bindings,
      });
      if (decision.outcome !== 'commit') return { ok: false, reason: decision.outcome };

      // A metadata failure here leaves Infisical ahead of the plane: the pending write recorded above
      // makes the ref reconcile-required, and the next locked call settles it (G1c E1).
      const committed = await metadataCall(() =>
        deps.metadata.commit({
          ref,
          version: decision.version,
          // Only `rotate` snapshots the grace companion, so only `rotate` opens a grace window; a `put`
          // replacing a secret leaves the replaced version unresolvable (Codex review PR #2646 P2).
          previousVersion: rotation ? observedBefore : null,
          rotatedAt: rotation && before !== null ? deps.now() : null,
          record: written,
        }),
      );
      // No row updated (a revoke landed after this write's revoked check) or the commit failed.
      if (committed !== true) return { ok: false, reason: 'write_unverified' };
      return { ok: true, version: decision.version };
    });

    if (lockResult.outcome === 'lock_busy') return { ok: false, reason: 'lock_unavailable' };
    if (lockResult.outcome === 'connection_error') return { ok: false, reason: 'store_unavailable' };
    return lockResult.result === 'metadata_unavailable' ? { ok: false, reason: 'store_unavailable' } : lockResult.result;
  }

  async function resolveCore(input: {
    readonly ref: SecretRef;
    readonly grant: Parameters<typeof decideResolve>[0]['grant'];
    readonly identity: StoreIdentity;
  }): Promise<{ readonly ok: true; readonly kind: AccountKind; readonly material: unknown; readonly version: CredentialVersion } | { readonly ok: false; readonly reason: string }> {
    const { ref, grant, identity } = input;
    if (ref.tenantId !== identity.tenantId) return { ok: false, reason: 'not_found' };

    const stored = await readReconciled(ref, identity.identityId);
    if (stored === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };
    const decision = decideResolve({ grant, identity, ref, stored, now: deps.now(), rotationGraceMs, hash: deps.hash });
    if (!decision.ok) return decision;

    const store = await lookupStore(ref.tenantId, identity.identityId);
    if (store === null) return { ok: false, reason: 'store_unavailable' };

    // decideResolve already confirmed grant.credentialVersion is EITHER stored.currentVersion or
    // (within grace) stored.previousVersion; fetch the matching Infisical copy and return the
    // version actually served, not always the current one (Codex review PR #2646 P1).
    const servedFromCurrent = grant.credentialVersion === stored!.currentVersion;
    const secretKey = servedFromCurrent ? secretKeyFor(ref.accountId, ref.kind) : previousSecretKeyFor(ref.accountId, ref.kind);
    const got = await deps.infisical.getSecret({ projectId: store.projectId, credentials: store.credentials, secretKey });
    if (!got.ok) return { ok: false, reason: got.reason === 'not_found' ? 'not_found' : 'store_unavailable' };

    if (servedFromCurrent) {
      // Race guard: a rotation could have landed between our metadata read and this fetch, in
      // which case Infisical's own version has moved past what decideResolve authorized — refuse
      // rather than serve rotated material mislabeled as the old version (Codex review PR #2646 P1).
      if (got.secret.version !== stored!.currentVersion) return { ok: false, reason: 'store_unavailable' };
    } else {
      let previousComment: PreviousSnapshotComment;
      try {
        previousComment = JSON.parse(got.secret.secretComment) as PreviousSnapshotComment;
      } catch {
        return { ok: false, reason: 'store_unavailable' };
      }
      if (!isRecord(previousComment) || previousComment.__version !== stored!.previousVersion) return { ok: false, reason: 'store_unavailable' };
    }

    let parsed: { readonly kind: AccountKind; readonly material: unknown };
    try {
      parsed = JSON.parse(got.secret.secretValue) as { kind: AccountKind; material: unknown };
    } catch {
      return { ok: false, reason: 'store_unavailable' };
    }
    // The payload must be the ref's kind; stripping is decided by the ref, never by what the store says it holds (G1c review).
    if (!isRecord(parsed) || parsed.kind !== ref.kind) return { ok: false, reason: 'store_unavailable' };

    const material = stripRefreshToken(ref.kind, parsed.material as never, grant.aud);
    return { ok: true, kind: ref.kind, material, version: grant.credentialVersion as CredentialVersion };
  }

  return {
    async put(input: PutInput) {
      return writeSecret({ ...input, rotation: false });
    },

    async resolve<C extends PresenterChannel, K extends ResolvableBy<C>>(input: ResolveInput<C, K>): Promise<ResolveResult<C, K>> {
      const result = await resolveCore({ ref: input.ref, grant: input.grant, identity: input.identity });
      if (!result.ok) return result as ResolveResult<C, K>;
      if (result.version !== input.version) return { ok: false, reason: 'version_mismatch' };
      return { ok: true, kind: result.kind as K, material: result.material as MaterialForChannel<C, K>, version: result.version };
    },

    async resolveSessionOverHttp(input: SessionHttpResolveInput): Promise<ResolveResult<'http-executor', 'session'>> {
      const result = await resolveCore({ ref: input.ref, grant: input.grant, identity: input.identity });
      if (!result.ok) return result as ResolveResult<'http-executor', 'session'>;
      if (result.version !== input.version) return { ok: false, reason: 'version_mismatch' };
      return { ok: true, kind: 'session', material: result.material as MaterialForChannel<'http-executor', 'session'>, version: result.version };
    },

    async rotate(input: RotateInput): Promise<RotateResult> {
      return writeSecret({ ref: input.ref, material: input.next, expectedVersion: input.expectedVersion, bindings: input.bindings, scope: null, consenters: null, identity: input.identity, rotation: true });
    },

    async rebind(input: RebindInput): Promise<RebindResult> {
      // G1c E3: the manage role is enforced here at runtime, not only in RebindInput's type.
      const caller = decideStoreCaller({ identity: input.identity, ref: input.ref, required: 'manage' });
      if (!caller.ok) return caller;

      // Under the writers' lock so a rebind never interleaves with a put/rotate. The SQL update also
      // compares the stored policy_version, so the CAS holds at the row itself. A rebind writes only
      // the bindings row, never Infisical, so the secret's version never moves (G1c R4).
      const next: PlaneBindingsRecord = { bindings: input.bindings, scope: input.scope, consenters: input.consenters };
      const lockResult = await withSecretLock(input.ref, async (): Promise<RebindResult> => {
        const stored = await metadataCall(() => deps.metadata.read(input.ref));
        if (stored === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };

        const decision = decideRebind({
          ref: input.ref,
          stored: stored === null ? null : recordOf(stored),
          storedRevoked: stored !== null && stored.revokedAt !== null,
          expectedVersion: input.expectedVersion,
          next,
          consent: input.consent,
          consentPublicKey: deps.consentPublicKey,
          now: deps.now(),
          maxAgeMs: REBIND_CONSENT_MAX_AGE_MS,
          verify: deps.verify,
          hash: deps.hash,
        });
        if (decision.outcome === 'refuse') return { ok: false, reason: decision.reason };

        // G1c E2: the consent is spent before the write, once across every replica.
        if (decision.consumeConsentId !== null && input.consent !== null) {
          const consumeConsentId = decision.consumeConsentId;
          const issuedAt = input.consent.issuedAt;
          const outcome = await deps.consentLedger
            .consume({ consentId: consumeConsentId, expiresAt: issuedAt + REBIND_CONSENT_MAX_AGE_MS, now: deps.now() })
            .catch(() => 'unavailable' as const);
          const consumption = decideConsentConsumption({ outcome });
          if (!consumption.ok) return consumption;
        }

        const updated = await metadataCall(() => deps.metadata.updateBindings({ ref: input.ref, expectedPolicyVersion: input.expectedVersion, record: next }));
        if (updated === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };
        if (!updated) return { ok: false, reason: 'version_conflict' };

        // Post-write verify (ADR 0005 §2.2): the plane must now hold exactly the consented record.
        const after = await metadataCall(() => deps.metadata.read(input.ref));
        if (after === METADATA_UNAVAILABLE || after === null || canonicalJson(recordOf(after)) !== canonicalJson(next)) return { ok: false, reason: 'write_unverified' };
        return { ok: true, policyVersion: input.bindings.policyVersion };
      });

      if (lockResult.outcome === 'lock_busy') return { ok: false, reason: 'lock_unavailable' };
      if (lockResult.outcome === 'connection_error') return { ok: false, reason: 'store_unavailable' };
      return lockResult.result;
    },

    async revoke(input: RevokeInput): Promise<RevokeResult> {
      const caller = decideStoreCaller({ identity: input.identity, ref: input.ref, required: 'manage' });
      if (!caller.ok) return caller;
      const stored = await metadataCall(() => deps.metadata.read(input.ref));
      if (stored === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };
      if (stored === null) return { ok: false, reason: 'not_found' };
      // The FIRST revocation is the one REVOKE_RETENTION_MS counts from; a repeated revoke must not
      // restart that clock.
      if (stored.revokedAt !== null) return { ok: true, revokedAt: stored.revokedAt };
      const revokedAt = deps.now();
      const marked = await metadataCall(() => deps.metadata.markRevoked({ ref: input.ref, revokedAt, reason: input.reason }));
      if (marked === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };
      if (marked) return { ok: true, revokedAt };

      // Nothing marked: a delete removed the row, or another revoke recorded first. Report what is there.
      const after = await metadataCall(() => deps.metadata.read(input.ref));
      if (after === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };
      if (after === null) return { ok: false, reason: 'not_found' };
      return after.revokedAt === null ? { ok: false, reason: 'store_unavailable' } : { ok: true, revokedAt: after.revokedAt };
    },

    async delete(input: DeleteInput): Promise<DeleteResult> {
      const caller = decideStoreCaller({ identity: input.identity, ref: input.ref, required: 'manage' });
      if (!caller.ok) return caller;
      const store = await lookupStore(input.ref.tenantId, input.identity.identityId);
      if (store === null) return { ok: false, reason: 'store_unavailable' };
      const { projectId, credentials } = store;

      // Under the writers' lock: a rotate already past its read would otherwise commit AFTER this
      // delete and re-insert the metadata row (or re-write the grace companion) — an erasure that
      // does not stay erased. A reconcile-required ref is erased like any other.
      const lockResult = await withSecretLock(input.ref, async (): Promise<DeleteResult | null> => {
        const stored = await metadataCall(() => deps.metadata.read(input.ref));
        if (stored === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };

        // The grace companion holds the material `rotate` replaced; erasing the account must erase
        // it too. Deleted FIRST: absent (never rotated) is fine, any other failure stops before the
        // primary secret or the metadata row go, so a retried delete still finds both and resumes.
        const previous = await deps.infisical.deleteSecret({ projectId, credentials, secretKey: previousSecretKeyFor(input.ref.accountId, input.ref.kind) });
        if (!previous.ok && previous.reason !== 'not_found') return { ok: false, reason: 'store_unavailable' };

        const secretKey = secretKeyFor(input.ref.accountId, input.ref.kind);
        const result = await deps.infisical.deleteSecret({ projectId, credentials, secretKey });
        // The metadata row still exists, so a primary already gone is a delete that was interrupted
        // after this step — finish it rather than leave a permanent ghost row (Codex review PR #2646 P2).
        if (!result.ok && result.reason !== 'not_found') return { ok: false, reason: 'store_unavailable' };

        // No metadata row: nothing to remove there, but Infisical is still searched — a first put whose
        // commit failed leaves material with no row, and an erasure must not miss it. Nothing anywhere
        // is not_found.
        if (stored === null) return previous.ok || result.ok ? null : { ok: false, reason: 'not_found' };

        const removed = await metadataCall(() => deps.metadata.remove(input.ref));
        if (removed === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };
        return null;
      });

      if (lockResult.outcome !== 'acquired') return { ok: false, reason: 'store_unavailable' };
      if (lockResult.result !== null) return lockResult.result;
      return { ok: true, removed: true, upstream: input.upstream };
    },

    async describe(input: DescribeInput): Promise<DescribeResult> {
      const caller = decideStoreCaller({ identity: input.identity, ref: input.ref, required: 'manage' });
      if (!caller.ok) return caller;
      const stored = await readReconciled(input.ref, input.identity.identityId);
      if (stored === METADATA_UNAVAILABLE) return { ok: false, reason: 'store_unavailable' };
      if (stored === null) return { ok: false, reason: 'not_found' };
      // A write that could not be reconciled has no single true version to describe (G1c E1).
      if (stored.pendingWrite !== null) return { ok: false, reason: 'store_unavailable' };
      return {
        ok: true,
        kind: stored.kind,
        version: stored.currentVersion,
        // Plane-attested (G1c R3 + M7): the verifier's previousCredentialVersion / rotatedAt come from here.
        previousVersion: stored.previousVersion,
        bindings: stored.bindings,
        consenters: stored.consenters,
        createdAt: stored.createdAt,
        rotatedAt: stored.rotatedAt,
        revokedAt: stored.revokedAt,
      };
    },
  };
}
