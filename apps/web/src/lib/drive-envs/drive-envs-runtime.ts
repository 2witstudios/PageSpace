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
  gateLocalEnvForRequester,
  type DriveEnvPayer,
} from '@pagespace/lib/services/drive-envs/env-provision-deps';
import type { LiveConnectionReader, LocalEnvGateVerdict } from '@pagespace/lib/services/drive-envs/local-env-gate';
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
import type { RevokeLocalDriveEnvResult } from '@pagespace/lib/services/drive-envs/local-env-revoke';
import { getSandboxHost } from '@/lib/agent-workspaces/sandbox-host-runtime';
import { createHash, createPublicKey, randomBytes, verify as nodeVerify } from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import { loadServerSigningKey } from '@pagespace/lib/auth/env-bridge-signing-key';
import { sessionService } from '@pagespace/lib/auth/session-service';
import {
  enrollLocalDriveEnv,
  issueLocalEnvChallenge,
  redeemLocalEnvChallenge,
  type LocalEnvIdentityDeps,
  type LocalEnvIdentityServiceDeps,
  type EnrollLocalDriveEnvResult,
  type IssueLocalEnvChallengeResult,
  type RedeemLocalEnvChallengeResult,
} from '@pagespace/lib/services/drive-envs/drive-envs';

export { toDriveEnvDTO };
export type { DriveEnvDTO };

// ---------------------------------------------------------------------------
// Lazy singleton — the store reconnects to one DB pool; it is built on first
// use so importing this module does no DB work.
// ---------------------------------------------------------------------------

let envStorePromise: Promise<DriveEnvStore> | null = null;

/**
 * This replica's bridge-socket registry reading, loaded lazily: the registry
 * builds its logger at import, and this runtime is imported by many suites
 * that stub the logging module — the same reason the sandbox host is loaded
 * with `await import()` rather than statically.
 */
async function liveConnectionReader(): Promise<LiveConnectionReader> {
  const { readEnvLiveConnection } = await import('@/lib/websocket/ws-env-connections');
  return readEnvLiveConnection;
}

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

// ---------------------------------------------------------------------------
// Local-env identity: this process's cryptographic primitives, injected into
// the pure gates. Built lazily and ONLY on a local-env path, because loading
// the server signing key throws when ENV_BRIDGE_SIGNING_KEY is unset (fail
// closed, invariant 3) — and a Sprite-only deployment must never trip on it.
// ---------------------------------------------------------------------------

let identityDeps: LocalEnvIdentityDeps | null = null;

function envBridgeIdentity(): LocalEnvIdentityDeps {
  if (identityDeps) return identityDeps;
  const signingKey = loadServerSigningKey();
  identityDeps = {
    random: (length) => new Uint8Array(randomBytes(length)),
    // SHA3-256, matching how tokens are hashed at rest (`secureCompare` / `hashToken`).
    hash: (bytes) => createHash('sha3-256').update(bytes).digest('hex'),
    fingerprint: (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    isEd25519PublicKey: (spki) => {
      try {
        return createPublicKey({ key: Buffer.from(spki), type: 'spki', format: 'der' }).asymmetricKeyType === 'ed25519';
      } catch {
        return false;
      }
    },
    verify: (message, signature, publicKey) => {
      try {
        return nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
      } catch {
        return false;
      }
    },
    newEnrollmentId: () => `enr_${createId()}`,
    signingKey: { keyId: signingKey.keyId, publicKey: signingKey.publicKey },
  };
  return identityDeps;
}

async function localEnvIdentityServiceDeps(): Promise<LocalEnvIdentityServiceDeps> {
  const store = await getDriveEnvStore();
  return {
    store,
    now: () => new Date(),
    identity: envBridgeIdentity(),
    // The socket token is the machine OWNER's, bound to this env (resourceId)
    // and drive; the env-bridge socket route checks scope, resource and the
    // enrollment before accepting it. Type 'mcp' so no generic web route
    // (which validates `expectedType: 'user'`) will ever accept it.
    mintToken: (policy, machine) =>
      sessionService.createSession({
        userId: machine.ownerId,
        type: policy.type,
        scopes: policy.scopes,
        expiresInMs: policy.ttlMs,
        resourceType: 'drive_env',
        resourceId: machine.envId,
        driveId: machine.driveId,
        createdByService: 'env-bridge',
      }),
    // The compensating revoke for a revocation that lands between the challenge
    // CAS and the mint (C4): the real session revoker, keyed by the raw token
    // the mint just returned.
    revokeToken: (token, machine) => sessionService.revokeSession(token, `env_bridge_${machine.reason}`),
  };
}

export async function createEnvInDrive(input: {
  driveId: string;
  name: string;
  createdBy: string;
  /** Present for a LOCAL env: the machine label and its owner (the creating user). */
  local?: { label: string; ownerId: string };
}): Promise<CreateDriveEnvResult> {
  const store = await getDriveEnvStore();
  return createDriveEnv({
    driveId: input.driveId,
    name: input.name,
    createdBy: input.createdBy,
    local: input.local,
    deps: {
      store,
      resolvePayer: resolveDriveEnvPayer,
      now: () => new Date(),
      identity: input.local ? envBridgeIdentity() : undefined,
    },
  });
}

export async function enrollLocalEnv(input: { enrollmentId: string; code: unknown; machinePublicKey: unknown }): Promise<EnrollLocalDriveEnvResult> {
  const deps = await localEnvIdentityServiceDeps();
  return enrollLocalDriveEnv({ enrollmentId: input.enrollmentId, code: input.code, machinePublicKey: input.machinePublicKey, deps });
}

export async function issueEnvChallenge(input: { enrollmentId: string }): Promise<IssueLocalEnvChallengeResult> {
  const deps = await localEnvIdentityServiceDeps();
  return issueLocalEnvChallenge({ enrollmentId: input.enrollmentId, deps });
}

export async function redeemEnvChallenge(input: { enrollmentId: string; response: unknown }): Promise<RedeemLocalEnvChallengeResult> {
  const deps = await localEnvIdentityServiceDeps();
  return redeemLocalEnvChallenge({ enrollmentId: input.enrollmentId, response: input.response, deps });
}

export async function listEnvsInDrive(driveId: string): Promise<DriveEnvDTO[]> {
  const [store, liveConnection] = await Promise.all([getDriveEnvStore(), liveConnectionReader()]);
  // `liveConnection` is THIS replica's bridge-socket registry (t07): a socket
  // held here wins; otherwise a local env's status derives from its heartbeat
  // (`deriveLocalEnvStatus`), which whichever replica holds the socket writes.
  return listDriveEnvs({ driveId, deps: { store, now: () => new Date(), liveConnection } });
}

export async function renameEnv(input: { envId: string; name: string }): Promise<RenameDriveEnvResult> {
  const store = await getDriveEnvStore();
  return renameDriveEnv({ envId: input.envId, name: input.name, deps: { store, now: () => new Date() } });
}

/**
 * Revoke a LOCAL env's machine (Codex C4, all three legs) — the button the M1
 * exit gate presses through DELETE. Re-exported from the env-bridge adapter so
 * the route has one seam to mock.
 */
export async function revokeEnv(input: { envId: string; reason: string }): Promise<RevokeLocalDriveEnvResult> {
  const { revokeLocalEnv } = await import('@/lib/env-bridge/revoke');
  return revokeLocalEnv(input);
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
  const [store, host, liveConnection] = await Promise.all([getDriveEnvStore(), getSandboxHost(), liveConnectionReader()]);
  return ensureDriveEnvSandbox({
    envId: input.envId,
    intent: input.intent,
    requesterId: input.requesterId,
    deps: {
      store,
      host,
      resolvePayer: resolveDriveEnvPayer,
      liveConnection,
      resolveLocalHost: localHostResolver,
    },
  });
}

/**
 * The LOCAL-env `SandboxHost` factory this process hands the provisioner
 * (t09). Loaded lazily, for the same reason `liveConnectionReader` is: the
 * registry builds its logger at import and many suites stub the logging
 * module.
 *
 * NO grant principal, deliberately. A provision is a BIND — it asks whether
 * the machine is connected and nothing else, and it has no conversation to
 * name. So it gets the connectivity-only transport, whose `sendGrant` refuses
 * rather than signing under an invented identity: if some future edit tries to
 * run a command from the provisioning path, it fails loudly instead of
 * attributing the command to a principal nobody authorized. Grants are sent
 * from the tool path, through a transport built for the acting principal.
 */
async function localHostResolver({ envId }: { envId: string }) {
  const { resolveSandboxHost } = await import('@/lib/agent-workspaces/sandbox-host-registry');
  return resolveSandboxHost({ kind: 'local', envId });
}

/**
 * The server-side bind gate for a LOCAL env at session SPAWN (C1) — the same
 * assembly (`gateLocalEnvForRequester`) the provisioner runs on every ensure,
 * so a spawn and an ensure can never answer differently. A vanished env is
 * `revoked` here: the spawn service has already proven the env exists and
 * belongs to the drive, so this only ever sees a row that disappeared between
 * the two reads.
 */
export async function gateLocalEnvBind(input: { envId: string; requesterId: string }): Promise<LocalEnvGateVerdict> {
  const [store, liveConnection] = await Promise.all([getDriveEnvStore(), liveConnectionReader()]);
  const row = await store.findById(input.envId);
  if (!row) return { ok: false, refusal: 'revoked' };
  return gateLocalEnvForRequester({ row, requesterId: input.requesterId, deps: { store, resolvePayer: resolveDriveEnvPayer, liveConnection } });
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
  // No `resolveLocalHost` on this path, and that is not an omission:
  // `rebuildDriveEnv` refuses a local env with `substrate_unsupported` before
  // it ever reaches the provisioner (rebuild is destroy-and-re-mint, and a
  // local env has no Sprite to destroy).
  const [store, host, liveConnection] = await Promise.all([getDriveEnvStore(), getSandboxHost(), liveConnectionReader()]);
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
          deps: { store, host, resolvePayer: resolveDriveEnvPayer, liveConnection },
        }),
    },
  });
}
