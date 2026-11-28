/**
 * `createPlaneRefreshWorker` — the refresh worker as the plane process wires it
 * (slice 3): its store reads go through `refreshPresentation` (ADR 0005 §10d),
 * its ledger and lock live in the plane metadata DB, and its account writes
 * (version mirror, `needs_reauth`) go to the main-DB reference row. One
 * function, so the plane and its end-to-end suite wire it identically.
 */
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { GrantId, HashBytes, Nonce, PresenterKeyId } from '../grant';
import type { StoreAdapter } from '../store/store-adapter';
import type { PlaneMetadataRepository } from '../store/plane-metadata-repository';
import type { TenantProvisioner } from '../store/infisical-tenant-provisioner-client';
import type { AgentAccountRepository } from '../agent-account-repository';
import type { PinnedHttpsClient } from './pinned-https-client';
import type { OAuthEndpointRegistry } from '../refresh/decide-refresh-endpoint';
import type { OAuthClientCredentials } from '../refresh/build-refresh-request';
import { createRefreshWorker, type RefreshWorker } from '../refresh/refresh-worker';
import { createRefreshAttemptRepository } from '../refresh/refresh-attempt-repository';
import { refreshPresentation } from './refresh-presentation';

/** Refresh an access token with less than this left, so a request never presents one that expires in flight. */
export const REFRESH_MARGIN_MS = 2 * 60_000;

export function createPlaneRefreshWorker(deps: {
  readonly store: Pick<StoreAdapter, 'resolve' | 'rotate'>;
  readonly metadata: Pick<PlaneMetadataRepository, 'read'>;
  readonly advisoryLockPool: AdvisoryLockPool;
  readonly metadataPool: Pool;
  readonly provisioner: Pick<TenantProvisioner, 'identityOf'>;
  readonly accounts: Pick<AgentAccountRepository, 'advanceCredentialVersion' | 'markNeedsReauth'>;
  readonly network: PinnedHttpsClient;
  readonly endpoints: OAuthEndpointRegistry;
  readonly clientFor: (providerSlug: string) => OAuthClientCredentials | null;
  readonly presenterKeyId: PresenterKeyId;
  /** SHA3-256. */
  readonly hash: HashBytes;
  readonly now: () => number;
}): RefreshWorker {
  const identityFor = (ref: { readonly tenantId: string }) =>
    deps.provisioner.identityOf(ref.tenantId as never).then((tenant) => (tenant === null ? null : { tenantId: ref.tenantId as never, identityId: tenant.identityId, channel: 'refresh-worker' as const, blastRadius: 'tenant' as const }));
  return createRefreshWorker({
    store: deps.store,
    resolveRefreshable: async ({ ref, version }) => {
      const [facts, identity] = await Promise.all([deps.metadata.read(ref), identityFor(ref)]);
      if (facts === null || identity === null) return { ok: false, reason: 'store_unavailable' };
      const grant = refreshPresentation({
        ref,
        version,
        bindings: facts.bindings,
        presenterKeyId: deps.presenterKeyId,
        grantId: randomBytes(18).toString('base64url') as GrantId,
        nonce: randomBytes(18).toString('base64url') as Nonce,
        now: deps.now(),
        hash: deps.hash,
      });
      return deps.store.resolve({ ref, version, grant, identity });
    },
    currentVersion: (ref) => deps.metadata.read(ref).then((facts) => facts?.currentVersion ?? null),
    identityFor,
    attempts: createRefreshAttemptRepository({ pool: deps.metadataPool }),
    advisoryLockPool: deps.advisoryLockPool,
    network: deps.network,
    registry: deps.endpoints,
    clientFor: deps.clientFor,
    accounts: deps.accounts,
    now: deps.now,
    marginMs: REFRESH_MARGIN_MS,
  });
}
