/**
 * build-core — the PURE decision layer for the published-app build & deploy
 * pipeline.
 *
 * INVARIANT, the same one `provisioner-core` carries: zero I/O. No db, no fetch,
 * no env read, no clock, no `child_process`. Every input is an argument, every
 * output is a value, and nothing throws. `build-job.ts`, `deployer.ts` and
 * `image-builder.ts` are the imperative shells that call these.
 *
 * What lives here is everything a build gets WRONG in ways that are invisible at
 * runtime: which statuses may start a build, what a machine's config must contain,
 * how a digest is recognised, and how big the pushed image actually was. Those are
 * exactly the decisions worth pinning with exhaustive tests rather than discovering
 * from a 502.
 */

import type { MachineConfig, MachineGuest } from '../fly/flaps-client';
import type { PublishedAppStatus } from '@pagespace/db/schema/published-apps';

/**
 * The port a published app MUST listen on inside its machine.
 *
 * Not a preference. Phase 3 routes to these apps with fly-replay, and Fly's proxy
 * requires the router and the target to expose matching public ports — so the
 * external 80/443 handlers are fixed, and the internal port they forward to has to
 * be a constant the runtime contract can state. An app that binds anything else is
 * unreachable no matter how healthy it is.
 */
export const PUBLISHED_APP_INTERNAL_PORT = 8080;

/** Fly's registry. Images push to `<this>/<flyAppName>`, never to a shared repo. */
export const FLY_REGISTRY_HOST = 'registry.fly.io';

/**
 * The repository an app's images push to.
 *
 * FLY REQUIRES THE REPOSITORY NAME TO MATCH AN EXISTING APP — a push to
 * `registry.fly.io/anything-else` is rejected — so each published app pushes to
 * its own repo, and the per-app deploy token (403 on every sibling app) is exactly
 * scoped to it. A single shared builder repo would have been fewer moving parts and
 * would have required an org-wide credential in the build worker instead.
 */
export function imageRepositoryFor(flyAppName: string): string {
  return `${FLY_REGISTRY_HOST}/${flyAppName}`;
}

/** `sha256:` + 64 lowercase hex. Anything else is not a digest we will pin. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isImageDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

/**
 * The image reference a machine is created from: ALWAYS `repo@sha256:…`, never
 * `repo:tag`.
 *
 * A tag is a mutable pointer. Creating a machine from one means the bytes a machine
 * boots are whatever the tag meant at create time, which is unknowable afterwards
 * and differs between the machine we health-checked and the machine that replaces
 * it after a restart. Pinning the digest makes "what code is this app running" a
 * question the database can answer — which is why `published_apps.imageDigest` is
 * a CHECK-enforced requirement for `deploying` and `running`.
 */
export function pinnedImageRef(flyAppName: string, digest: string): string {
  return `${imageRepositoryFor(flyAppName)}@${digest}`;
}

/**
 * The tag a build pushes under, derived from the source it was built from.
 *
 * The tag is bookkeeping only — every machine is created from the digest — but a
 * push needs SOME reference, and an OCI tag is a restricted charset
 * (`[A-Za-z0-9_][A-Za-z0-9._-]*`, 128 max). A source ref is a user-influenced
 * string, so it is sanitized rather than trusted: an unsanitized ref would either
 * fail the push with an opaque registry error or, worse, inject a second
 * `:`/`@` and retarget the push.
 */
export function buildTagFor(sourceRef: string): string {
  const cleaned = sourceRef.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9_]+/, '');
  const truncated = cleaned.slice(0, 100);
  return truncated.length > 0 ? `src-${truncated}` : 'src-unknown';
}

/**
 * The name of the machine a digest is deployed onto.
 *
 * DERIVED FROM THE DIGEST, and that is the whole point: machine names are unique
 * within an app, so a create keyed on this name is IDEMPOTENT — `createMachine`
 * resolves an "already exists" conflict by looking the machine up instead of
 * creating a second one. A worker that crashes after Fly created the machine but
 * before it recorded the id therefore converges on retry rather than leaving a
 * billable orphan behind. An unnamed create has no such key and double-bills.
 *
 * The digest also makes the name meaningful: `srv-<12 hex>` says which image the
 * machine is serving, so a blue/green pair is distinguishable in `fly machines
 * list` without cross-referencing anything.
 */
export function machineNameForDigest(digest: string): string {
  return `srv-${digest.replace(/^sha256:/, '').slice(0, 12)}`;
}

/**
 * The guest sizing for a preset. Returns null for an unknown preset rather than
 * throwing or defaulting — defaulting would silently create a machine of a size
 * the unit-economics guardrail never approved, and the `published_apps`
 * `guestPreset` CHECK exists precisely so that set stays deliberate.
 */
export function guestForPreset(preset: string): MachineGuest | null {
  if (preset === 'shared-cpu-1x-512') return { cpu_kind: 'shared', cpus: 1, memory_mb: 512 };
  return null;
}

export interface BuildMachineConfigInput {
  flyAppName: string;
  digest: string;
  guestPreset: string;
  publishedAppId: string;
  /** Extra environment for the app process. `PORT` is set by us and cannot be overridden. */
  env?: Record<string, string>;
}

/**
 * The full machine config for a published app.
 *
 * WHOLE-CONFIG, always. Fly's machine update replaces the entire config, and this
 * pipeline never updates one — every deploy CREATES a machine from a pinned digest
 * and destroys the previous one. That is not stylistic: a machine's rootfs is
 * assembled at CREATE, so an in-place image change is not even expressible, and
 * partial config surgery is the documented way to silently delete an app's
 * `services` (see `updateMachineConfig`, the only sanctioned mutation path, which
 * this pipeline deliberately does not use).
 *
 * `autostop: 'off'` with `autostart: true` is the metering shape decided in the
 * epic: Fly's proxy may WAKE a stopped machine (that is how a request reaches a
 * scaled-to-zero app at all), but only our own idle reaper stops it, so the
 * stop timestamp we bill against is an API call we made rather than a behaviour we
 * inferred.
 */
export function buildMachineConfig(input: BuildMachineConfigInput): MachineConfig | null {
  const guest = guestForPreset(input.guestPreset);
  if (guest === null) return null;

  return {
    image: pinnedImageRef(input.flyAppName, input.digest),
    guest,
    env: {
      ...(input.env ?? {}),
      // Last, so a caller-supplied PORT cannot move the app off the port the
      // router will forward to.
      PORT: String(PUBLISHED_APP_INTERNAL_PORT),
    },
    services: [
      {
        protocol: 'tcp',
        internal_port: PUBLISHED_APP_INTERNAL_PORT,
        // 80 and 443 on the target, matching the router — fly-replay requires it.
        ports: [
          { port: 80, handlers: ['http'] },
          { port: 443, handlers: ['tls', 'http'] },
        ],
        autostart: true,
        autostop: 'off',
        min_machines_running: 0,
      },
    ],
    metadata: {
      pagespace_published_app_id: input.publishedAppId,
      pagespace_image_digest: input.digest,
    },
    restart: { policy: 'on-failure', max_retries: 3 },
  };
}

/**
 * Pull the pushed image's digest out of `docker buildx imagetools inspect
 * --format '{{json .Manifest}}'`.
 *
 * Returns null on anything that is not a well-formed digest — including a valid
 * JSON document with a `digest` field of the wrong shape. A build that cannot prove
 * its digest must fail rather than pin something unverified, because the pinned
 * value is what every future machine boots.
 */
export function parseManifestDigest(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const digest = (parsed as { digest?: unknown }).digest;
  if (typeof digest !== 'string' || !isImageDigest(digest)) return null;
  return digest;
}

/**
 * Total registry size of an image, from its RAW manifest: the config blob plus
 * every layer.
 *
 * Returns null rather than a wrong number in the two cases where the honest answer
 * is "not from this document": unparseable JSON, and a manifest LIST/index (which
 * describes several per-platform images and has no single size). Builds here are
 * single-platform with provenance and SBOM attestations disabled precisely so the
 * pushed artifact is a plain manifest and this stays answerable — but a null must
 * be survivable, because the size is a cost signal and the deploy is not allowed to
 * fail over one.
 */
export function parseImageSizeBytes(rawManifest: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const doc = parsed as { config?: unknown; layers?: unknown; manifests?: unknown };
  // An index/manifest-list: several images, no single size.
  if (Array.isArray(doc.manifests)) return null;
  if (!Array.isArray(doc.layers)) return null;

  const sizeOf = (value: unknown): number => {
    if (typeof value !== 'object' || value === null) return 0;
    const size = (value as { size?: unknown }).size;
    return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0;
  };

  let total = sizeOf(doc.config);
  for (const layer of doc.layers) total += sizeOf(layer);
  return total;
}

export type BuildStartRefusal =
  | 'disabled'
  | 'not_found'
  | 'still_provisioning'
  | 'deploy_in_flight'
  | 'parked'
  | 'being_destroyed'
  | 'failed_needs_retry';

export type BuildStartPlan =
  /** Already `building` — the provisioner handed the app over; go straight to work. */
  | { action: 'build' }
  /** A live app being redeployed: move it to `building` first, then work. */
  | { action: 'promote' }
  | { action: 'refuse'; reason: BuildStartRefusal };

/**
 * May a build start against an app in this status?
 *
 * Two legal entries, and the difference is who moved the row: a fresh publish
 * arrives already `building` (the provisioner set it after creating the Fly app),
 * while a REDEPLOY arrives `running` or `stopped` and has to be promoted first.
 * Everything else is a refusal, and each refusal names a distinct situation an
 * operator would ask about:
 *
 *  - `provisioning` — the Fly app may not exist yet; a push would 404 on a
 *    repository that has no app behind it.
 *  - `deploying` — a blue/green swap is mid-flight. A second build would create a
 *    machine the first one is about to consider "the old machine" and destroy.
 *  - `failed` — recoverable, but only through the provisioner's explicit retry
 *    edge (`failed → provisioning`), never by a build job re-entering behind it.
 *  - `parked` / `destroying` — enforcement and teardown. Neither is a state where
 *    spending build minutes on an app makes sense.
 */
export function planBuildStart(status: PublishedAppStatus): BuildStartPlan {
  switch (status) {
    case 'building':
      return { action: 'build' };
    case 'running':
    case 'stopped':
      return { action: 'promote' };
    case 'provisioning':
      return { action: 'refuse', reason: 'still_provisioning' };
    case 'deploying':
      return { action: 'refuse', reason: 'deploy_in_flight' };
    case 'parked':
      return { action: 'refuse', reason: 'parked' };
    case 'destroying':
      return { action: 'refuse', reason: 'being_destroyed' };
    case 'failed':
      return { action: 'refuse', reason: 'failed_needs_retry' };
  }
}

/**
 * How long a build/deploy may sit before the reconciler treats it as dead, how many
 * rows one pass takes, and how many automatic re-queues an app gets.
 */
export interface BuildReconcilerPolicy {
  staleThresholdMs: number;
  batchLimit: number;
  maxAttempts: number;
}

/**
 * Defaults sized against what a real build costs: a slim image builds and pushes in
 * single-digit minutes, and a blue/green deploy adds a machine create (~10–20s for
 * rootfs assembly) plus a health check. Twenty minutes is comfortably past the tail
 * of both, so nothing healthy is ever reclaimed mid-flight — the failure this
 * threshold guards against is a worker that DIED, and those never finish.
 */
export const DEFAULT_BUILD_RECONCILER_POLICY: BuildReconcilerPolicy = {
  staleThresholdMs: 20 * 60 * 1000,
  batchLimit: 25,
  maxAttempts: 3,
};

/** Read a positive integer from env, falling back on anything unparseable. */
function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function resolveBuildReconcilerPolicy(
  env: Record<string, string | undefined>,
): BuildReconcilerPolicy {
  return {
    staleThresholdMs: positiveInt(
      env.APP_BUILD_STALE_THRESHOLD_MS,
      DEFAULT_BUILD_RECONCILER_POLICY.staleThresholdMs,
    ),
    batchLimit: positiveInt(env.APP_BUILD_RECONCILE_BATCH, DEFAULT_BUILD_RECONCILER_POLICY.batchLimit),
    maxAttempts: positiveInt(
      env.APP_BUILD_MAX_RECONCILE_ATTEMPTS,
      DEFAULT_BUILD_RECONCILER_POLICY.maxAttempts,
    ),
  };
}

export interface StuckAppEvidence {
  publishedAppId: string;
  status: PublishedAppStatus;
  /**
   * The build input the artifact source resolved for this app RIGHT NOW — not a
   * value read back off the row. `published_apps` deliberately records no source
   * pointer: the environment is the answer to "what is published", and a copy on
   * the hosting row would be a second, unsynchronised one. Null means the source
   * could not be resolved, so there is nothing to re-run.
   */
  sourceRef: string | null;
  /** How many times the reconciler has already re-queued THIS app. */
  priorAttempts: number;
}

export type StuckAppRecovery =
  | { action: 'requeue'; attempt: number; sourceRef: string }
  | { action: 'fail'; reason: 'no_source_ref' | 'attempts_exhausted'; message: string };

/**
 * What to do with an app found stuck in `building`/`deploying` past the horizon.
 *
 * Re-queue by default — a stuck row is nearly always a worker that died mid-build,
 * and the build is safe to re-run: the push is content-addressed, the machine create
 * is keyed on a name derived from the digest, and the old machine is untouched until
 * a new one passes its health check. Failing such an app instead would turn every
 * worker restart into a user-visible publish failure.
 *
 * Two things stop the loop. An app whose build input cannot be resolved has
 * nothing to re-run — the promoted artifact is gone, or the env no longer offers
 * one — and an app that has already burned its attempts is failing for a reason
 * retrying will not fix; the point of a bounded count is that a build broken by
 * the user's own Dockerfile stops consuming a worker slot every twenty minutes
 * forever.
 */
export function planStuckAppRecovery(
  evidence: StuckAppEvidence,
  policy: BuildReconcilerPolicy,
): StuckAppRecovery {
  if (evidence.sourceRef === null || evidence.sourceRef.length === 0) {
    return {
      action: 'fail',
      reason: 'no_source_ref',
      message: `Build stuck in '${evidence.status}' with no resolvable source to rebuild from`,
    };
  }
  if (evidence.priorAttempts >= policy.maxAttempts) {
    return {
      action: 'fail',
      reason: 'attempts_exhausted',
      message:
        `Build stuck in '${evidence.status}' after ${evidence.priorAttempts} automatic ` +
        `recovery attempt(s); giving up`,
    };
  }
  return { action: 'requeue', attempt: evidence.priorAttempts + 1, sourceRef: evidence.sourceRef };
}
