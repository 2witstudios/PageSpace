/**
 * `createInfisicalStoreAdapter` — the `StoreAdapter` implementation against
 * self-hosted Infisical OSS (D-21 revised; ADR 0005 §2). I/O only: every
 * decision is `decideCas` / `decideResolve` / `decideResolveCaller` /
 * `decidePlaneBinding`; this file reads, writes, locks and calls them.
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
 */
import type { AccountKind, CredentialVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { HashBytes, PresenterChannel } from '../grant';
import type {
  DeleteInput,
  DeleteResult,
  DescribeInput,
  DescribeResult,
  MaterialForChannel,
  PlaneBindings,
  PutInput,
  PutResult,
  ResolvableBy,
  ResolveInput,
  ResolveResult,
  RevokeInput,
  RevokeResult,
  RotateInput,
  RotateResult,
  SecretMaterial,
  SecretMaterialByKind,
  SecretRef,
  SessionHttpResolveInput,
  StoreAdapter,
  StoreLimits,
} from './store-adapter';
import type { InfisicalClient, InfisicalCredentials } from './infisical-client';
import type { PlaneMetadataRepository } from './plane-metadata-repository';
import { lockKeyFor } from './plane-metadata-repository';
import { decideCas } from './decide-cas';
import { decideResolve } from './decide-resolve';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';

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
};

const ROTATION_GRACE_MS_DEFAULT = 300_000;
/**
 * `withAdvisoryLock` (packages/db) is a TRY lock — a competitor mid-write
 * gets `lock_busy` immediately rather than waiting. A bounded retry turns
 * that into real serialization: the loser waits for the winner to finish,
 * then re-reads under its OWN lock acquisition and sees the bumped version,
 * so two concurrent writers with the same `expectedVersion` resolve to
 * exactly one `commit` and one genuine `version_conflict` (ADR 0005 §10.8),
 * never a spurious `lock_unavailable`.
 */
const LOCK_RETRY_ATTEMPTS = 40;
const LOCK_RETRY_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secretKeyFor(accountId: string, kind: AccountKind): string {
  return `${accountId}__${kind}`;
}

function stripRefreshToken<K extends AccountKind>(kind: K, material: SecretMaterial['material'], aud: PresenterChannel): unknown {
  if (kind !== 'oauth2' || aud === 'refresh-worker') return material;
  const { refreshToken: _refreshToken, ...rest } = material as SecretMaterialByKind['oauth2'];
  return rest;
}

export function createInfisicalStoreAdapter(deps: StoreAdapterInfisicalDeps): StoreAdapter {
  const rotationGraceMs = (deps.rotationGraceMs ?? ROTATION_GRACE_MS_DEFAULT) as StoreLimits['rotationGraceMs'];

  async function writeSecret(input: {
    readonly ref: PutInput['ref'];
    readonly material: SecretMaterial;
    readonly expectedVersion: CredentialVersion | null;
    readonly bindings: PlaneBindings;
    readonly identity: PutInput['identity'];
  }): Promise<PutResult> {
    const { ref, material, expectedVersion, bindings, identity } = input;
    if (ref.tenantId !== identity.tenantId) return { ok: false, reason: 'store_unavailable' };

    const project = await deps.resolveProject(ref.tenantId);
    const credentials = await deps.resolveCredentials({ tenantId: ref.tenantId, identityId: identity.identityId });
    if (project === null || credentials === null) return { ok: false, reason: 'store_unavailable' };

    const lockKey = lockKeyFor(ref);
    const attemptLock = () => withAdvisoryLock(deps.advisoryLockPool, lockKey, async () => {
      const before = await deps.metadata.read(ref);
      // A revoked ref is broker-denied permanently, never reactivated by a later write (ADR 0005
      // §2.2 revoke: "every future resolve returns revoked"). Refuse under the SAME lock a write
      // would use, before touching Infisical or the metadata row (Codex review PR #2646 P1).
      if (before !== null && before.revokedAt !== null) return { outcome: 'write_unverified' as const };
      const observedBefore = (before?.currentVersion ?? null) as CredentialVersion | null;

      const assumedNextVersion = ((observedBefore ?? 0) + 1) as CredentialVersion;
      const preCheck = decideCas({ expectedVersion, observedBefore, observedAfter: assumedNextVersion, bindingsAfter: bindings, bindingsWritten: bindings });
      if (preCheck.outcome === 'version_conflict') return preCheck;

      const secretKey = secretKeyFor(ref.accountId, ref.kind);
      // `material` is the discriminated SecretMaterial wrapper ({ kind, material: perKindPayload });
      // store only the per-kind payload so resolve hands callers exactly the shape they expect
      // (Codex review PR #2646 P1 — the wrapper was stored whole, doubly nesting the payload and
      // hiding oauth2's refreshToken one level deeper than stripRefreshToken looked).
      const secretValue = JSON.stringify({ kind: ref.kind, material: material.material });
      const secretComment = JSON.stringify(bindings);
      const writeResult =
        before === null
          ? await deps.infisical.createSecret({ projectId: project.projectId, credentials, secretKey, secretValue, secretComment })
          : await deps.infisical.updateSecret({ projectId: project.projectId, credentials, secretKey, secretValue, secretComment });
      if (!writeResult.ok) return { outcome: 'write_unverified' as const };

      const verify = await deps.infisical.getSecret({ projectId: project.projectId, credentials, secretKey });
      if (!verify.ok) return { outcome: 'write_unverified' as const };

      let verifiedBindings: PlaneBindings;
      try {
        verifiedBindings = JSON.parse(verify.secret.secretComment) as PlaneBindings;
      } catch {
        return { outcome: 'write_unverified' as const };
      }

      const decision = decideCas({
        expectedVersion,
        observedBefore,
        observedAfter: verify.secret.version as CredentialVersion,
        bindingsAfter: verifiedBindings,
        bindingsWritten: bindings,
      });
      if (decision.outcome !== 'commit') return decision;

      await deps.metadata.commit({
        ref,
        version: decision.version,
        previousVersion: observedBefore,
        bindings,
        rotatedAt: before === null ? null : deps.now(),
      });
      return decision;
    });

    let lockResult = await attemptLock();
    for (let attempt = 0; lockResult.outcome === 'lock_busy' && attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
      await sleep(LOCK_RETRY_DELAY_MS);
      lockResult = await attemptLock();
    }

    if (lockResult.outcome === 'lock_busy') return { ok: false, reason: 'lock_unavailable' };
    if (lockResult.outcome === 'connection_error') return { ok: false, reason: 'store_unavailable' };
    const decision = lockResult.result;
    if (decision.outcome === 'commit') return { ok: true, version: decision.version };
    if (decision.outcome === 'version_conflict') return { ok: false, reason: 'version_conflict' };
    return { ok: false, reason: 'write_unverified' };
  }

  async function resolveCore(input: {
    readonly ref: SecretRef;
    readonly grant: Parameters<typeof decideResolve>[0]['grant'];
    readonly identity: { readonly tenantId: TenantId; readonly identityId: string };
  }): Promise<{ readonly ok: true; readonly kind: AccountKind; readonly material: unknown; readonly version: CredentialVersion } | { readonly ok: false; readonly reason: string }> {
    const { ref, grant, identity } = input;
    if (ref.tenantId !== identity.tenantId) return { ok: false, reason: 'not_found' };

    const stored = await deps.metadata.read(ref);
    const decision = decideResolve({ grant, ref, stored, now: deps.now(), rotationGraceMs, hash: deps.hash });
    if (!decision.ok) return decision;

    const project = await deps.resolveProject(ref.tenantId);
    const credentials = await deps.resolveCredentials({ tenantId: ref.tenantId, identityId: identity.identityId });
    if (project === null || credentials === null) return { ok: false, reason: 'store_unavailable' };

    const secretKey = secretKeyFor(ref.accountId, ref.kind);
    const got = await deps.infisical.getSecret({ projectId: project.projectId, credentials, secretKey });
    if (!got.ok) return { ok: false, reason: got.reason === 'not_found' ? 'not_found' : 'store_unavailable' };

    let parsed: { readonly kind: AccountKind; readonly material: unknown };
    try {
      parsed = JSON.parse(got.secret.secretValue) as { kind: AccountKind; material: unknown };
    } catch {
      return { ok: false, reason: 'store_unavailable' };
    }

    const material = stripRefreshToken(parsed.kind, parsed.material as never, grant.aud);
    return { ok: true, kind: parsed.kind, material, version: stored!.currentVersion as CredentialVersion };
  }

  return {
    async put(input: PutInput) {
      return writeSecret(input);
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
      return writeSecret({ ref: input.ref, material: input.next, expectedVersion: input.expectedVersion, bindings: input.bindings, identity: input.identity });
    },

    async revoke(input: RevokeInput): Promise<RevokeResult> {
      if (input.ref.tenantId !== input.identity.tenantId) return { ok: false, reason: 'not_found' };
      const stored = await deps.metadata.read(input.ref);
      if (stored === null) return { ok: false, reason: 'not_found' };
      const revokedAt = deps.now();
      await deps.metadata.markRevoked({ ref: input.ref, revokedAt });
      return { ok: true, revokedAt };
    },

    async delete(input: DeleteInput): Promise<DeleteResult> {
      const project = await deps.resolveProject(input.ref.tenantId);
      const credentials = await deps.resolveCredentials({ tenantId: input.ref.tenantId, identityId: input.identity.identityId });
      if (project === null || credentials === null) return { ok: false, reason: 'store_unavailable' };

      const stored = await deps.metadata.read(input.ref);
      if (stored === null) return { ok: false, reason: 'not_found' };

      const secretKey = secretKeyFor(input.ref.accountId, input.ref.kind);
      const result = await deps.infisical.deleteSecret({ projectId: project.projectId, credentials, secretKey });
      if (!result.ok) return { ok: false, reason: result.reason === 'not_found' ? 'not_found' : 'store_unavailable' };

      await deps.metadata.remove(input.ref);
      return { ok: true, removed: true, upstream: input.upstream };
    },

    async describe(input: DescribeInput): Promise<DescribeResult> {
      if (input.ref.tenantId !== input.identity.tenantId) return { ok: false, reason: 'not_found' };
      const stored = await deps.metadata.read(input.ref);
      if (stored === null) return { ok: false, reason: 'not_found' };
      return {
        ok: true,
        kind: stored.kind,
        version: stored.currentVersion,
        bindings: stored.bindings,
        createdAt: stored.createdAt,
        rotatedAt: stored.rotatedAt,
        revokedAt: stored.revokedAt,
      };
    },
  };
}
