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
import {
  ensureSpriteHolderSandbox,
  type EnsureSpriteHolderSandboxResult,
  type SpriteHolderProvisionDeps,
  type SpriteHolderProvisionIntent,
} from '../agent-workspaces/agent-workspace-sprite';
import type { SandboxHost } from '../sandbox/sandbox-host';
import type { SubscriptionTier } from '../subscription-utils';
import type { DriveEnvRecord, DriveEnvStore } from './drive-envs-store';

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
  'updateSpriteIdentity' | 'applyStamps' | 'reloadSpritePointer' | 'enqueueReclaim'
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
    now: () => new Date(),
  };
}

export interface EnsureDriveEnvSandboxDeps {
  store: DriveEnvProvisionStore & Pick<DriveEnvStore, 'findById'>;
  host: SandboxHost;
  /**
   * The drive's payer and tier, or null when the drive is gone. Null FAILS the
   * provision closed rather than folding this env's Sprite key under some other
   * tenant — see `DriveEnvPayer`.
   */
  resolvePayer: (driveId: string) => Promise<DriveEnvPayer | null>;
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
