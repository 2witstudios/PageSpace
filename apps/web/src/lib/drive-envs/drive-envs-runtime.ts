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
import { refreshSessionStorageMeasurement } from '@pagespace/lib/services/sandbox/sandbox-storage-measure';
import { resolveSandboxNetworkOptions } from '@pagespace/lib/services/sandbox/network-options';
import { getConfiguredEgressIpTag } from '@pagespace/lib/services/sandbox/egress-ip';
import { deriveDriveEnvSpriteKey } from '@pagespace/lib/drive-envs/env-sprite-key';
import {
  ensureSpriteHolderSandbox,
  type SpriteHolderProvisionDeps,
} from '@pagespace/lib/services/agent-workspaces/agent-workspace-sprite';
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
import type { SandboxHost } from '@pagespace/lib/services/sandbox/sandbox-host';
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
/**
 * The env's flavor of every seam the holder-neutral provisioner asks for.
 *
 * Extracted from `rebuildEnv` below because this — not the verb that calls it —
 * is where an environment's provisioning correctness actually lives. The core
 * derives no Sprite key, resolves no tenant and picks no authorization gate of
 * its own, so getting any of these wrong is silent, and burying them four
 * closures deep inside a lifecycle call made them read like plumbing rather than
 * the decisions they are. `drive-envs-runtime.test.ts` asserts on exactly this
 * object.
 *
 * `payer` is the DRIVE OWNER, resolved by the caller and passed in — the tenant
 * an env's Sprite key folds under, with no fallback, for the same reason
 * `resolveSessionTenantId` fails closed: a different tenant means a different
 * key means a second Sprite identity for one env.
 */
function buildEnvProvisionDeps({
  row,
  payer,
  requesterId,
  store,
  host,
}: {
  row: DriveEnvRecord;
  payer: { payerId: string; tier: SubscriptionTier };
  requesterId: string;
  store: DriveEnvStore;
  host: SandboxHost;
}): SpriteHolderProvisionDeps {
  return {
    // The identity/stamp slice, renamed holder → env. This adapter IS what makes
    // an env a second holder of the ONE provisioning CAS rather than a second
    // provisioner with its own.
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
    /** The ENV keyspace (`drive-env-sprite:v1`), never the session one — see `env-sprite-key.ts` on why a shared namespace is a reclaim hazard rather than a tidiness question. */
    deriveSpriteKey: (holderId) =>
      deriveDriveEnvSpriteKey({ tenantId: payer.payerId, envId: holderId, secret: getSandboxSessionSecret() }),
    /**
     * The centralized code-execution gate, resolved against the env's DRIVE and
     * its payer — which is also where tier eligibility lives, so a downgraded
     * payer is refused here rather than deeper in.
     */
    authorize: async () => {
      const result = await canRunCode({
        userId: requesterId,
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
    /**
     * The env ALLOWANCE is metered where the commitment is made — at
     * `createDriveEnv`, on the row. Provisioning an env that already exists adds
     * no allocation to count, so there is no second ceiling here; what this
     * re-asserts is tier ELIGIBILITY, so a payer downgraded since the env was
     * created stops getting machines for it. That is the same fact `authorize`
     * denies on (`can-run-code`'s tier gate), re-checked at the mint site as
     * defense in depth and reported under the same word rather than dressed up
     * as a quota it is not.
     */
    checkQuota: async () => {
      if (isSandboxAvailable(payer.tier)) return { allowed: true };
      return { allowed: false, denial: 'not_authorized', reason: 'tier_ineligible' };
    },
    /**
     * Opportunistic storage measurement — the WRITE side of the meter that
     * bills this env.
     *
     * An env is the billed PERSISTENCE unit, and the storage reconcile only ever
     * READS `drive_envs.storageMeasuredBytes`. With no writer an env prices at
     * the never-measured 0 floor forever while the cron keeps advancing its
     * watermark, permanently discarding every interval — an env would be free,
     * silently, which is the one outcome the billing work exists to prevent.
     * Wired at the env's provisioning deps rather than inside the holder-neutral
     * core for the reason every other seam here is: WHICH row a measurement
     * lands on is the holder kind's answer, not the provisioner's.
     *
     * Fired by the core on the `create` arm only, against a Sprite that is
     * already awake — never by waking a hibernating one. That baseline is a
     * floor rather than a truth: an env accumulates its real footprint across
     * sessions, and refreshing it from warm env sessions is the sessions-in-env
     * path's own seam to call, using this same store writer.
     */
    measureStorage: async ({ holderId, handle }) => {
      await refreshSessionStorageMeasurement({
        handle,
        // The holder-neutral seam still names its subject `workspaceId`; here it
        // addresses a `drive_envs` row, which is what `persist` below writes to.
        workspaceId: holderId,
        // The generation just minted — the CAS target for the write. Taken from
        // the handle, not the row: this is the VM the `du` runs on.
        spriteInstanceId: handle.spriteInstanceId ?? null,
        // NULL, not the row's value: this callback only fires on the `create`
        // arm, where the same operation resets the measurement columns (a new
        // Sprite generation is an empty filesystem). Passing the pre-provision
        // timestamp would let the throttle skip the baseline measurement of an
        // env rebuilt inside the window, leaving the row stale with no other
        // trigger to fix it.
        lastMeasuredAt: null,
        now: new Date(),
        persist: ({ workspaceId, spriteInstanceId, measuredBytes, measuredAt }) =>
          store.recordStorageMeasurement({ envId: workspaceId, spriteInstanceId, measuredBytes, measuredAt }),
      });
    },
    now: () => new Date(),
  };
}

export async function rebuildEnv(input: { envId: string; requesterId: string }): Promise<RebuildDriveEnvResult> {
  const [store, host] = await Promise.all([getDriveEnvStore(), getSandboxHost()]);
  return rebuildDriveEnv({
    envId: input.envId,
    deps: {
      store,
      host,
      now: () => new Date(),
      ensureSandbox: async (row) => {
        // Fails CLOSED on a vanished drive: there is no tenant to fold the
        // Sprite key under, and inventing one would split this env across two
        // Sprite identities.
        const payer = await resolveDriveEnvPayer(row.driveId);
        if (!payer) return { ok: false, reason: 'provision_failed', detail: 'drive_not_found' };
        return ensureSpriteHolderSandbox({
          row: { ...row, holderId: row.id, endedAt: null },
          // `ensure`, not `reprovision`: the teardown already happened and was
          // confirmed, so the row reads as machineless and the core takes its
          // `create` arm — through the same CAS every other provisioner runs.
          intent: 'ensure',
          deps: buildEnvProvisionDeps({ row, payer, requesterId: input.requesterId, store, host }),
        });
      },
    },
  });
}
