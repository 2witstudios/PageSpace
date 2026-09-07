/**
 * The ENV's flavor of every seam the holder-neutral provisioner asks for, plus
 * the one verb that runs it.
 *
 * **Why this is in `@pagespace/lib` rather than in an app.** It began life as a
 * private helper in `apps/web`'s drive-env runtime, where `rebuildDriveEnv` was
 * the only caller. It has two more now, in two different processes: the web
 * tier's `provisionSessionSandbox` and the realtime tier's shell bridge both
 * have to provision an environment when a session bound to one asks for a
 * sandbox. What is written down here is not plumbing — it is which KEYSPACE an
 * env's Sprite name folds in, which TENANT it folds under, which gate decides
 * who may run code in it, and what a refusal is called. Every one of those is
 * silent when it is wrong: a session keyspace would derive the name of a
 * different holder's VM, and a second tenant would split one env across two
 * Sprite identities. A copy per process is a copy per process to get wrong, and
 * the copies drift where nobody is looking. So the decisions live once, here,
 * and each app injects only what it genuinely owns — its store and its Sprites
 * host.
 *
 * Nothing in this module DECIDES a lifecycle: whether an env's Sprite is
 * created, resumed, adopted or refused is `planSpriteHolderLifecycle`'s answer,
 * reached through the one `ensureSpriteHolderSandbox` core. In particular this
 * is `ensure`, never a second provisioning path — the identity CAS that
 * serializes concurrent provisions of one env only serializes them if every
 * provisioner runs the same one, which is exactly the property that makes N
 * sessions opening at once in one env yield ONE VM.
 */

import { canRunCode, isCodeExecutionEnabled } from '../sandbox/can-run-code';
import { isSandboxAvailable } from '../../billing/sandbox-eligibility';
import { decideFullEgressEnablement, isContainmentVerified } from '../sandbox/containment';
import { getSandboxSessionSecret } from '../sandbox/machine-session-manager';
import { resolveSandboxNetworkOptions } from '../sandbox/network-options';
import { getConfiguredEgressIpTag } from '../sandbox/egress-ip';
import { deriveDriveEnvSpriteKey } from '../../drive-envs/env-sprite-key';
import { envStorageMeasureSeam } from './env-storage-measure';
import {
  ensureSpriteHolderSandbox,
  type EnsureSpriteHolderSandboxResult,
  type SpriteHolderProvisionDeps,
  type SpriteHolderProvisionIntent,
} from '../agent-workspaces/agent-workspace-sprite';
import { LocalEnvNotConnectedError, type SandboxHost } from '../sandbox/sandbox-host';
import type { SubscriptionTier } from '../subscription-utils';
import type { DriveEnvRecord, DriveEnvStore } from './drive-envs-store';
import { isLocalEnvsEnabled } from './local-envs-enabled';
import { gateLocalEnv, noLiveConnections, resolveDriveActorRole, type LiveConnectionReader, type LocalEnvGateVerdict } from './local-env-gate';
import type { ActorRole } from '../../env-bridge/decide-bind';

/**
 * The env's PAYER — the drive's OWNER — and their tier.
 *
 * Both halves matter and neither has a fallback. The payer id is the TENANT the
 * Sprite key folds under, so substituting anyone else (the acting user, say)
 * derives a different name for the same env and hands back a different machine.
 * The tier is what `checkQuota` re-asserts below.
 */
export interface DriveEnvPayer {
  payerId: string;
  tier: SubscriptionTier;
}

/** The store slice env provisioning needs — the Sprite-holder methods and nothing else. */
export type DriveEnvProvisionStore = Pick<
  DriveEnvStore,
  | 'updateSpriteIdentity'
  | 'applyStamps'
  | 'reloadSpritePointer'
  | 'enqueueReclaim'
  // The measurement writer. In the slice because provisioning is the only moment
  // an env's storage is measured at all — see `measureStorage` below.
  | 'recordStorageMeasurement'
>;

/**
 * Build the env's `SpriteHolderProvisionDeps`.
 *
 * `requesterId` is who this provision authorizes as. `payer` is resolved by the
 * caller and passed in — it is a database fact about the drive, and this module
 * takes no database.
 */
export function buildEnvProvisionDeps({
  row,
  payer,
  requesterId,
  store,
  host,
}: {
  row: Pick<DriveEnvRecord, 'driveId'>;
  payer: DriveEnvPayer;
  requesterId: string;
  store: DriveEnvProvisionStore;
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
     *
     * This is also the whole of a SESSION's authorization to use the env it is
     * bound to. Spawning proved the env belongs to the session's drive; this
     * proves, on every ensure, that the actor may run code in that drive. There
     * is deliberately no separate env-membership concept to check — an env has
     * no permissions of its own, by design.
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
     *
     * Note which ceiling is NOT here: the per-owner live-SESSION ceiling
     * (`checkAgentSessionConcurrency`). An env session allocates no VM of its
     * own, so there is no session-shaped allocation to count — the env is the
     * billed unit, and counting sessions against it would charge a team for
     * opening two windows onto one machine.
     */
    checkQuota: async () => {
      if (isSandboxAvailable(payer.tier)) return { allowed: true };
      return { allowed: false, denial: 'not_authorized', reason: 'tier_ineligible' };
    },
    /**
     * Opportunistic storage measurement — the WRITE side of the meter that bills
     * this env, and the reason an environment is not free.
     *
     * Wired HERE rather than in any one app's composition precisely because this
     * module is the single path every provisioner reaches: the web tier's
     * rebuild, and a session's ensure in both the web and realtime tiers. A copy
     * per composition would be a copy per composition to forget, and forgetting
     * it is silent — the storage reconcile only READS
     * `drive_envs.storageMeasuredBytes`, so an env with no writer prices at the
     * never-measured 0 floor forever while the cron keeps advancing its
     * watermark. No error, no failing test, just an environment that is free.
     *
     * Fires on the `create` arm only, against a Sprite the provisioner has just
     * booted. `env-storage-measure.ts` explains why `adopt` deliberately does
     * not: a `du` is an exec, and an exec is the only way to wake a hibernated
     * Sprite, so measuring where the VM's state is unproven would recreate the
     * keep-awake billing bug.
     */
    measureStorage: envStorageMeasureSeam(store),
    now: () => new Date(),
  };
}

export interface EnsureDriveEnvSandboxDeps {
  store: DriveEnvProvisionStore & Pick<DriveEnvStore, 'findById' | 'findLocalByEnvId'>;
  host: SandboxHost;
  /**
   * The drive's payer and tier, or null when the drive is gone. Null FAILS the
   * provision closed rather than folding this env's Sprite key under some other
   * tenant — see `DriveEnvPayer`.
   */
  resolvePayer: (driveId: string) => Promise<DriveEnvPayer | null>;
  /**
   * LOCAL envs only (C1). This replica's bridge-socket registry reading; absent
   * until the socket route (t07) exists, so status derives from the heartbeat.
   */
  liveConnection?: LiveConnectionReader;
  /** LOCAL envs only. Test seam; production resolves the role with the centralized permission helper. */
  resolveActorRole?: (input: { userId: string; driveId: string }) => Promise<ActorRole>;
  /** LOCAL envs only. `LOCAL_ENVS_ENABLED`; read from the environment when absent. */
  localEnvsEnabled?: boolean;
  /**
   * LOCAL envs only (t09). The `SandboxHost` that reaches this env's machine
   * over the bridge, built per env and per requester — never the Sprite host,
   * and never process-cached (the transport it closes over is bound to one
   * grant principal).
   *
   * OPTIONAL, and its absence is a REFUSAL rather than a fallback. The bridge
   * socket terminates in apps/web (`ws-env-connections.ts`), so a process that
   * holds no registry — the realtime tier, which runs this exact same
   * `ensureDriveEnvSandbox` — genuinely cannot reach the machine. It answers
   * `substrate_unsupported`, which is now narrowed to mean precisely that:
   * "this process cannot reach local environments". It never falls through to
   * the Sprite host.
   */
  resolveLocalHost?: (input: { envId: string; requesterId: string }) => Promise<SandboxHost>;
}

/**
 * The server-side gate for a LOCAL env, fed the real inputs from the same deps
 * a provision uses: the payer (so `canRunCode` bills the right tenant), the
 * requester's drive role, the flag and the live-socket reading. Shared by the
 * provisioner below and by the session-spawn bind, so both ask ONE question.
 */
export async function gateLocalEnvForRequester({
  row,
  requesterId,
  deps,
}: {
  row: Pick<DriveEnvRecord, 'id' | 'driveId' | 'substrate'>;
  requesterId: string;
  deps: Pick<EnsureDriveEnvSandboxDeps, 'store' | 'resolvePayer' | 'liveConnection' | 'resolveActorRole' | 'localEnvsEnabled'>;
}): Promise<LocalEnvGateVerdict> {
  const payer = await deps.resolvePayer(row.driveId);
  // A vanished drive has nobody to authorize against; the code-exec gate's own
  // vocabulary says so rather than this module inventing a verdict.
  const canRun = payer
    ? () => canRunCode({ userId: requesterId, driveId: row.driveId, ownerId: payer.payerId, requestOrigin: 'user' })
    : async () => ({ ok: false as const, reason: 'no_drive_access' as const });
  return gateLocalEnv({
    row,
    requesterId,
    deps: {
      store: deps.store,
      canRunCode: canRun,
      resolveActorRole: () => (deps.resolveActorRole ?? resolveDriveActorRole)({ userId: requesterId, driveId: row.driveId }),
      liveConnection: deps.liveConnection ?? noLiveConnections,
      flagEnabled: deps.localEnvsEnabled ?? isLocalEnvsEnabled(),
      now: () => new Date(),
    },
  });
}

/**
 * Provision (or resume/adopt) an ENVIRONMENT's one Sprite — the entry point a
 * session's ensure routes to when it carries `envId`, and the same core
 * `rebuildDriveEnv` runs after its teardown.
 *
 * Lazy by construction: an env row exists from the moment it is created, but
 * this is the first thing that ever mints a VM for it, so an env nobody has
 * opened a session in costs nothing.
 *
 * Every failure comes back as a typed result — a vanished env and a vanished
 * drive are both `provision_failed` with a naming detail, because both mean the
 * same thing to the session that asked: there is no machine here and there is
 * no point retrying until something changes.
 */
export async function ensureDriveEnvSandbox({
  envId,
  intent,
  requesterId,
  deps,
}: {
  envId: string;
  intent: SpriteHolderProvisionIntent;
  requesterId: string;
  deps: EnsureDriveEnvSandboxDeps;
}): Promise<EnsureSpriteHolderSandboxResult> {
  const row = await deps.store.findById(envId);
  if (!row) return { ok: false, reason: 'provision_failed', detail: 'env_not_found' };
  // C1: a LOCAL env never reaches the Sprite host. The pure planners decide
  // (via the gate), and t09 replaces the flat refusal that stood here with the
  // real local host — keeping every typed verdict for every case that still
  // refuses, and changing only the connected-and-allowed one.
  if (row.substrate === 'local') return ensureLocalEnvSandbox({ row, requesterId, deps });
  const payer = await deps.resolvePayer(row.driveId);
  if (!payer) return { ok: false, reason: 'provision_failed', detail: 'drive_not_found' };
  return ensureSpriteHolderSandbox({
    // An env has no `endedAt` column and no ended state — it is deleted, never
    // ended. Pinned null so the shared planner reads the row exactly as it is
    // rather than inferring a session-shaped lifecycle the env does not have.
    row: { ...row, holderId: row.id, endedAt: null },
    intent,
    deps: buildEnvProvisionDeps({ row, payer, requesterId, store: deps.store, host: deps.host }),
  });
}

/**
 * Bind an allowed, connected LOCAL env to its machine.
 *
 * The shape of this function is the whole of t09's provision threading, and
 * three things about it are load-bearing:
 *
 * - **The gate runs first and is unchanged.** Every refusal keeps the exact
 *   typed verdict t06b established (`flag_disabled`, `code_exec_denied`,
 *   `not_local`, `revoked`, `not_connected`, `bind_policy`) — this task
 *   changes what happens after an `ok`, and nothing about what happens before.
 * - **Nothing is written to the row.** Invariant 9 keeps every Sprite column
 *   NULL on a local env, which is what makes it structurally invisible to
 *   reclaim, storage billing and the egress predicates. So there is no
 *   identity CAS, no stamp, no reclaim enqueue and no storage measurement
 *   here — all of which the Sprite arm does, and every one of which would put
 *   a local row into a query that must never see it. The returned `sandboxId`
 *   is the DERIVED address (`localEnvSandboxId`), alive only for this request.
 * - **`resumed: true`, always.** The machine was already running: PageSpace
 *   did not create it and could not have. Reporting a `create` would tell the
 *   caller's revival/measurement paths that a fresh filesystem exists.
 */
async function ensureLocalEnvSandbox({
  row,
  requesterId,
  deps,
}: {
  row: DriveEnvRecord;
  requesterId: string;
  deps: EnsureDriveEnvSandboxDeps;
}): Promise<EnsureSpriteHolderSandboxResult> {
  const verdict = await gateLocalEnvForRequester({ row, requesterId, deps });
  if (!verdict.ok) return { ok: false, reason: 'local_refused', refusal: verdict.refusal, detail: verdict.cause ?? verdict.refusal };

  // No registry in this process (see `resolveLocalHost`). A typed refusal, and
  // deliberately NOT a fall-through to `deps.host`, which is the Sprite host.
  if (!deps.resolveLocalHost) {
    return { ok: false, reason: 'local_refused', refusal: 'substrate_unsupported', detail: 'substrate_unsupported' };
  }

  const localHost = await deps.resolveLocalHost({ envId: row.id, requesterId });
  try {
    const handle = await localHost.provision({
      // The env id IS the name: a local machine has one identity, its
      // enrollment, and there is no keyspace to fold — `deriveDriveEnvSpriteKey`
      // exists to keep two Sprite holders from colliding on a shared namespace,
      // and a local env holds no Sprite.
      name: row.id,
      substrate: { kind: 'local', envId: row.id },
      options: {},
    });
    return { ok: true, sandboxId: handle.sandboxId, resumed: true };
  } catch (error) {
    // The connection dropped between the gate's reading and the bind. The
    // refusal is the same word the gate would have used, so a caller sees one
    // vocabulary for one condition however it was detected.
    if (error instanceof LocalEnvNotConnectedError) {
      return { ok: false, reason: 'local_refused', refusal: 'not_connected', detail: 'not_connected' };
    }
    return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
