/**
 * `sweepOrphanedRefs` — erasure reaches the vault (L2·G2 review MED-1). I/O
 * only: pages through every ref the plane holds, asks the main DB which
 * account rows still exist, lets `decideOrphanedRefs` pick the orphans, and
 * deletes each one's material and plane metadata under the tenant's manage
 * role. Reference rows cascade away with their owning user (erasure
 * included), agent page or drive; without this the key would sit in the vault
 * with nothing left that could ever revoke or erase it.
 *
 * The plane process runs it on a timer (`plane-worker.ts`). A ref the sweep
 * cannot erase this time (its tenant is unknown, Infisical is down) is
 * counted as failed and retried on the next run; nothing here throws.
 */
import type { StoreAdapter } from '../store/store-adapter';
import type { PlaneMetadataRepository } from '../store/plane-metadata-repository';
import type { TenantProvisioner } from '../store/infisical-tenant-provisioner-client';
import type { AgentAccountRepository } from '../agent-account-repository';
import { decideOrphanedRefs } from './decide-orphaned-refs';

const PAGE_SIZE = 200;

export async function sweepOrphanedRefs({
  metadata,
  accounts,
  provisioner,
  store,
  now,
}: {
  readonly metadata: Pick<PlaneMetadataRepository, 'listRefs'>;
  readonly accounts: Pick<AgentAccountRepository, 'existingIds'>;
  readonly provisioner: Pick<TenantProvisioner, 'identityOf'>;
  readonly store: Pick<StoreAdapter, 'delete'>;
  readonly now: () => number;
}): Promise<{ readonly scanned: number; readonly erased: number; readonly failed: number }> {
  let scanned = 0;
  let erased = 0;
  let failed = 0;
  let after: Parameters<PlaneMetadataRepository['listRefs']>[0]['after'] = null;
  for (;;) {
    let page: Awaited<ReturnType<PlaneMetadataRepository['listRefs']>>;
    let live: readonly string[];
    try {
      page = await metadata.listRefs({ after, limit: PAGE_SIZE });
      if (page.length === 0) break;
      live = await accounts.existingIds(page.map(({ ref }) => ref.accountId));
    } catch {
      failed += 1;
      break;
    }
    scanned += page.length;
    for (const ref of decideOrphanedRefs({ refs: page, liveAccountIds: live, now: now() })) {
      const tenant = await provisioner.identityOf(ref.tenantId).catch(() => null);
      const deleted = tenant === null ? null : await store.delete({ ref, identity: { tenantId: ref.tenantId, identityId: tenant.identityId, channel: 'manage', blastRadius: 'tenant' }, upstream: 'not_attempted' }).catch(() => null);
      if (deleted?.ok === true) erased += 1;
      else failed += 1;
    }
    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1]!.ref;
  }
  return { scanned, erased, failed };
}
