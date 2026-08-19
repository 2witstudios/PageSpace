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
import { toSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import {
  ensureDriveEnvSandbox,
  type DriveEnvPayer,
} from '@pagespace/lib/services/drive-envs/env-provision-deps';
import type {
  EnsureSpriteHolderSandboxResult,
  SpriteHolderProvisionIntent,
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
import { getSandboxHost } from '@/lib/agent-workspaces/sandbox-host-runtime';

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
export async function resolveDriveEnvPayer(driveId: string): Promise<DriveEnvPayer | null> {
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
 * Provision the ENVIRONMENT a session runs inside — the binding
 * `ensureAgentSessionSandbox` routes to when a session carries `envId`.
 *
 * Every decision it makes is `ensureDriveEnvSandbox`'s (in `@pagespace/lib`,
 * shared with the realtime tier so the two processes cannot fold a Sprite key
 * differently); what lives here is this process's store, its Sprites host and
 * its payer lookup.
 */
export async function ensureEnvSandboxForSession(input: {
  envId: string;
  intent: SpriteHolderProvisionIntent;
  requesterId: string;
}): Promise<EnsureSpriteHolderSandboxResult> {
  const [store, host] = await Promise.all([getDriveEnvStore(), getSandboxHost()]);
  return ensureDriveEnvSandbox({
    envId: input.envId,
    intent: input.intent,
    requesterId: input.requesterId,
    deps: { store, host, resolvePayer: resolveDriveEnvPayer },
  });
}

/**
 * Rebuild an env's machine — teardown, then the ONE provisioning core, bound to
 * the ENV's flavor of each seam.
 *
 * `requesterId` is who this provision authorizes as; `ensureDriveEnvSandbox`
 * holds the seams themselves (which keyspace the Sprite name folds in, who may
 * run code here, what a refusal is called), because a session's ensure needs
 * exactly the same ones.
 */
export async function rebuildEnv(input: { envId: string; requesterId: string }): Promise<RebuildDriveEnvResult> {
  const [store, host] = await Promise.all([getDriveEnvStore(), getSandboxHost()]);
  return rebuildDriveEnv({
    envId: input.envId,
    deps: {
      store,
      host,
      now: () => new Date(),
      ensureSandbox: async (row) =>
        ensureDriveEnvSandbox({
          envId: row.id,
          // `ensure`, not `reprovision`: the teardown already happened and was
          // confirmed, so the row reads as machineless and the core takes its
          // `create` arm — through the same CAS every other provisioner runs.
          intent: 'ensure',
          requesterId: input.requesterId,
          deps: { store, host, resolvePayer: resolveDriveEnvPayer },
        }),
    },
  });
}
