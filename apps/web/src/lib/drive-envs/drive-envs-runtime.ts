/**
 * Production wiring for the drive-environment services (`@pagespace/lib`
 * services/drive-envs) — DI of the DB-backed store, the Sprites host, the payer
 * lookup and the permission checks.
 *
 * ZERO decision logic lives here, by the same mandate `agent-workspaces-runtime.ts`
 * states: every `if` below turns a null into another null. Anything that WEIGHS
 * facts lives in the pure planners (`drive-envs/plan-env-delete.ts`,
 * `plan-workspace-lifecycle.ts`) or in the centralized permission helpers, and
 * is merely executed by the services this module binds.
 *
 * The Sprites host is shared with the session runtime rather than re-created:
 * one process, one driver, and — more to the point — one place where the
 * Node-24/ESM-only `@fly/sprites` import is guarded.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { toSubscriptionTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { canRunCode, isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { isSandboxAvailable } from '@pagespace/lib/billing/sandbox-eligibility';
import {
  decideFullEgressEnablement,
  isContainmentVerified,
} from '@pagespace/lib/services/sandbox/containment';
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/machine-session-manager';
import { resolveSandboxNetworkOptions } from '@pagespace/lib/services/sandbox/network-options';
import { getConfiguredEgressIpTag } from '@pagespace/lib/services/sandbox/egress-ip';
import { deriveDriveEnvSpriteKey } from '@pagespace/lib/drive-envs/env-sprite-key';
import { ensureSpriteHolderSandbox } from '@pagespace/lib/services/agent-workspaces/agent-workspace-sprite';
import {
  createDbDriveEnvStore,
  type DriveEnvRecord,
  type DriveEnvStore,
} from '@pagespace/lib/services/drive-envs/drive-envs-store';
import {
  createDriveEnv,
  listDriveEnvs,
  renameDriveEnv,
  deleteDriveEnv,
  rebuildDriveEnv,
  toDriveEnvDTO,
  type CreateDriveEnvResult,
  type RenameDriveEnvResult,
  type DeleteDriveEnvResult,
  type RebuildDriveEnvResult,
} from '@pagespace/lib/services/drive-envs/drive-envs';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';
import { getSandboxHost } from '@/lib/agent-workspaces/agent-workspaces-runtime';

export { toDriveEnvDTO };
export type { DriveEnvDTO };

// ---------------------------------------------------------------------------
// Lazy singleton — the store reconnects to one DB pool; it is built on first
// use so importing this module does no DB work.
// ---------------------------------------------------------------------------

let envStorePromise: Promise<DriveEnvStore> | null = null;

export function getDriveEnvStore(): Promise<DriveEnvStore> {
  envStorePromise ??= createDbDriveEnvStore();
  return envStorePromise;
}

// ---------------------------------------------------------------------------
// Row-fact lookups (null-plumbing only)
// ---------------------------------------------------------------------------

/** The row, or null. Internal: every caller outside this module goes through `resolveEnvInDrive`, which additionally proves the env belongs to the drive in the path. */
async function findDriveEnvRecord(envId: string): Promise<DriveEnvRecord | null> {
  return (await getDriveEnvStore()).findById(envId);
}

/**
 * The drive's PAYER and their tier — its OWNER, with no fallback.
 *
 * No fallback is the whole content of this function. An env is drive-owned,
 * drive-shared and drive-billed, so a vanished drive has nobody to meter and
 * nobody to bill; falling back to the acting user would charge a member for a
 * machine the drive was going to pay for, and would fold this env's Sprite key
 * under a different tenant than the one it already provisioned under.
 */
export async function resolveDriveEnvPayer(
  driveId: string,
): Promise<{ payerId: string; tier: SubscriptionTier } | null> {
  const drive = await db.query.drives.findFirst({ where: eq(drives.id, driveId), columns: { ownerId: true } });
  if (!drive) return null;
  const owner = await db.query.users.findFirst({
    where: eq(users.id, drive.ownerId),
    columns: { subscriptionTier: true },
  });
  return { payerId: drive.ownerId, tier: toSubscriptionTier(owner?.subscriptionTier) };
}

// ---------------------------------------------------------------------------
// Entry wrappers — result unions, never throws, for the routes to map
// ---------------------------------------------------------------------------

/**
 * The env, IF it exists and genuinely belongs to the drive in the path.
 *
 * Returns null for both "no such env" and "wrong drive", deliberately: the
 * caller answers 404 either way, so the two are indistinguishable from outside.
 */
export async function resolveEnvInDrive(envId: string, driveId: string): Promise<DriveEnvRecord | null> {
  const env = await findDriveEnvRecord(envId);
  if (!env || env.driveId !== driveId) return null;
  return env;
}

export async function createEnvInDrive(input: {
  driveId: string;
  name: string;
  createdBy: string;
}): Promise<CreateDriveEnvResult> {
  const store = await getDriveEnvStore();
  return createDriveEnv({
    driveId: input.driveId,
    name: input.name,
    createdBy: input.createdBy,
    deps: { store, resolvePayer: resolveDriveEnvPayer, now: () => new Date() },
  });
}

export async function listEnvsInDrive(driveId: string): Promise<DriveEnvDTO[]> {
  const store = await getDriveEnvStore();
  return listDriveEnvs({ driveId, deps: { store } });
}

export async function renameEnv(input: { envId: string; name: string }): Promise<RenameDriveEnvResult> {
  const store = await getDriveEnvStore();
  return renameDriveEnv({ envId: input.envId, name: input.name, deps: { store, now: () => new Date() } });
}

export async function deleteEnv(input: { envId: string; force: boolean }): Promise<DeleteDriveEnvResult> {
  const [store, host] = await Promise.all([getDriveEnvStore(), getSandboxHost()]);
  return deleteDriveEnv({ envId: input.envId, force: input.force, deps: { store, host, now: () => new Date() } });
}

/**
 * Rebuild an env's machine — teardown, then the ONE provisioning core, bound to
 * the ENV's flavor of each seam.
 *
 * `requesterId` is who this provision authorizes as. Every seam below is the
 * env's answer to a question the core deliberately does not decide for itself:
 * which keyspace the Sprite name folds in (`drive-env-sprite:v1`, never the
 * session namespace), who may run code here, and what a refusal is called.
 */
export async function rebuildEnv(input: { envId: string; requesterId: string }): Promise<RebuildDriveEnvResult> {
  const [store, host] = await Promise.all([getDriveEnvStore(), getSandboxHost()]);
  return rebuildDriveEnv({
    envId: input.envId,
    deps: {
      store,
      host,
      now: () => new Date(),
      ensureSandbox: async (row) => {
        // The tenant an env's Sprite key folds under is the DRIVE OWNER, with
        // no fallback — same rule, and same failure mode if broken, as
        // `resolveSessionTenantId`: a different tenant means a different key
        // means a second Sprite identity for one env.
        const payer = await resolveDriveEnvPayer(row.driveId);
        if (!payer) return { ok: false, reason: 'provision_failed', detail: 'drive_not_found' };
        return ensureSpriteHolderSandbox({
          row: { ...row, holderId: row.id, endedAt: null },
          // `ensure`, not `reprovision`: the teardown already happened and was
          // confirmed, so the row reads as machineless and the core takes its
          // `create` arm — through the same CAS every other provisioner runs.
          intent: 'ensure',
          deps: {
            store: {
              updateSpriteIdentity: ({ holderId, ...identity }) =>
                store.updateSpriteIdentity({ envId: holderId, ...identity }),
              applyStamps: ({ holderId, stamps, cas }) => store.applyStamps({ envId: holderId, stamps, cas }),
              reloadSpritePointer: (holderId) => store.reloadSpritePointer(holderId),
              enqueueReclaim: (reclaim) => store.enqueueReclaim(reclaim),
            },
            host,
            substrate: { kind: 'sprite' },
            options: resolveSandboxNetworkOptions({ surface: 'session', egressIpTag: getConfiguredEgressIpTag() }),
            deriveSpriteKey: (holderId) =>
              deriveDriveEnvSpriteKey({
                tenantId: payer.payerId,
                envId: holderId,
                secret: getSandboxSessionSecret(),
              }),
            // The centralized code-execution gate, resolved against the env's
            // DRIVE and its payer — which is also where the tier-eligibility
            // check lives, so a downgraded payer is refused here rather than
            // deeper in.
            authorize: async () => {
              const result = await canRunCode({
                userId: input.requesterId,
                driveId: row.driveId,
                ownerId: payer.payerId,
                requestOrigin: 'user',
              });
              return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            },
            checkFullEgressEnablement: async () =>
              decideFullEgressEnablement({
                adminGateEnabled: isCodeExecutionEnabled(),
                containment: isContainmentVerified() ? { contained: true } : null,
              }),
            // The env ALLOWANCE is metered where the commitment is made — at
            // `createDriveEnv`, on the row, which is the billed persistence
            // unit. Provisioning an env that already exists adds no allocation
            // to count, so there is no second ceiling to apply here; what this
            // re-asserts is tier ELIGIBILITY, so a payer downgraded since the
            // env was created stops getting machines for it. That is the same
            // fact `authorize` above denies on (`can-run-code`'s tier gate),
            // re-checked at the mint site as defense in depth and reported
            // under the same word rather than dressed up as a quota it is not.
            checkQuota: async () => {
              if (isSandboxAvailable(payer.tier)) return { allowed: true };
              return { allowed: false, denial: 'not_authorized', reason: 'tier_ineligible' };
            },
            now: () => new Date(),
          },
        });
      },
    },
  });
}
