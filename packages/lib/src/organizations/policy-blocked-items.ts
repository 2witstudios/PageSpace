/**
 * What a policy change BLOCKS without suspending it (Spec POL-1; Review 3+4 P2-7). IO only: which kinds a change
 * newly forbids is decided by newlyBlockedKinds (policies-core.ts).
 *
 * Five kinds are not suspendable: published apps, persistent environments, agents from other drives, autonomous
 * agent runs and models. They are stopped where they are used, so the change itself touches no row. This reads
 * the existing items each newly forbidden kind reaches in the org's drives, so the audit row can list them: an
 * Owner or Admin sees what the change affected, the same way suspended items are listed.
 *
 * Bounded: each kind is counted in full and listed up to `limit` ids, newest first.
 */
import { db } from '@pagespace/db/db';
import { and, desc, eq, inArray, isNotNull, ne, notInArray, or, sql, type SQL } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { workflows } from '@pagespace/db/schema/workflows';
import type { BlockedKind, OrgPolicies } from './policies-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type BlockedResourceType = 'published_app' | 'drive_env' | 'agent_membership' | 'workflow' | 'agent_page';

export interface PolicyBlockedItem {
  kind: BlockedKind;
  resourceType: BlockedResourceType;
  id: string;
  driveId: string;
}

export interface PolicyBlockedItems {
  /** Every affected item, per kind. */
  counts: Partial<Record<BlockedKind, number>>;
  total: number;
  /** At most `limit` items per kind. */
  items: PolicyBlockedItem[];
}

/** The models a page agent names that `after` no longer allows (a page with no model of its own is not listed). */
function disallowedModel(after: OrgPolicies): SQL | undefined {
  const byModel = after.modelAllowlist === null
    ? undefined
    : and(isNotNull(pages.aiModel), after.modelAllowlist.length === 0 ? sql`true` : notInArray(pages.aiModel, after.modelAllowlist));
  const byProvider = after.providerAllowlist === null
    ? undefined
    : and(isNotNull(pages.aiProvider), after.providerAllowlist.length === 0 ? sql`true` : notInArray(pages.aiProvider, after.providerAllowlist));
  return byModel && byProvider ? or(byModel, byProvider) : (byModel ?? byProvider);
}

const RESOURCE_TYPE: Record<BlockedKind, BlockedResourceType> = {
  publishedApps: 'published_app',
  persistentEnvironments: 'drive_env',
  crossDriveAgents: 'agent_membership',
  agentsAutonomous: 'workflow',
  models: 'agent_page',
};

type Found = { rows: Array<{ id: string; driveId: string }>; n: number };
const count = sql<number>`count(*)::int`;

async function find(executor: Executor, kind: BlockedKind, orgDrives: SQL, after: OrgPolicies, limit: number): Promise<Found> {
  switch (kind) {
    case 'publishedApps': {
      const where = and(inArray(publishedApps.driveId, orgDrives), ne(publishedApps.status, 'destroying'));
      const [rows, [c]] = await Promise.all([
        executor.select({ id: publishedApps.id, driveId: publishedApps.driveId }).from(publishedApps).where(where).orderBy(desc(publishedApps.createdAt)).limit(limit),
        executor.select({ n: count }).from(publishedApps).where(where),
      ]);
      return { rows, n: c?.n ?? 0 };
    }
    case 'persistentEnvironments': {
      const where = inArray(driveEnvs.driveId, orgDrives);
      const [rows, [c]] = await Promise.all([
        executor.select({ id: driveEnvs.id, driveId: driveEnvs.driveId }).from(driveEnvs).where(where).orderBy(desc(driveEnvs.createdAt)).limit(limit),
        executor.select({ n: count }).from(driveEnvs).where(where),
      ]);
      return { rows, n: c?.n ?? 0 };
    }
    case 'crossDriveAgents': {
      // An agent attached to an org drive whose home is another drive.
      const where = and(inArray(driveAgentMembers.driveId, orgDrives), ne(pages.driveId, driveAgentMembers.driveId));
      const [rows, [c]] = await Promise.all([
        executor.select({ id: driveAgentMembers.id, driveId: driveAgentMembers.driveId }).from(driveAgentMembers)
          .innerJoin(pages, eq(pages.id, driveAgentMembers.agentPageId)).where(where).orderBy(desc(driveAgentMembers.addedAt)).limit(limit),
        executor.select({ n: count }).from(driveAgentMembers).innerJoin(pages, eq(pages.id, driveAgentMembers.agentPageId)).where(where),
      ]);
      return { rows, n: c?.n ?? 0 };
    }
    case 'agentsAutonomous': {
      // Enabled workflows run their agents without a person present (schedules and event triggers).
      const where = and(inArray(workflows.driveId, orgDrives), eq(workflows.isEnabled, true));
      const [rows, [c]] = await Promise.all([
        executor.select({ id: workflows.id, driveId: workflows.driveId }).from(workflows).where(where).orderBy(desc(workflows.createdAt)).limit(limit),
        executor.select({ n: count }).from(workflows).where(where),
      ]);
      return { rows, n: c?.n ?? 0 };
    }
    case 'models': {
      const where = and(inArray(pages.driveId, orgDrives), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false), disallowedModel(after));
      const [rows, [c]] = await Promise.all([
        executor.select({ id: pages.id, driveId: pages.driveId }).from(pages).where(where).orderBy(desc(pages.createdAt)).limit(limit),
        executor.select({ n: count }).from(pages).where(where),
      ]);
      return { rows, n: c?.n ?? 0 };
    }
  }
}

export async function listPolicyBlockedItems(
  executor: Executor,
  orgId: string,
  after: OrgPolicies,
  kinds: readonly BlockedKind[],
  limit: number,
): Promise<PolicyBlockedItems> {
  const out: PolicyBlockedItems = { counts: {}, total: 0, items: [] };
  const orgDrives = sql`(select ${drives.id} from ${drives} where ${drives.orgId} = ${orgId})`;
  for (const kind of kinds) {
    const { rows, n } = await find(executor, kind, orgDrives, after, limit);
    if (n === 0) continue;
    out.counts[kind] = n;
    out.total += n;
    out.items.push(...rows.map((r) => ({ kind, resourceType: RESOURCE_TYPE[kind], id: r.id, driveId: r.driveId })));
  }
  return out;
}
