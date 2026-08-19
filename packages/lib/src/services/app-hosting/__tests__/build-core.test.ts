import { describe } from 'vitest';
import { assert } from '../../../__tests__/riteway';
import {
  buildMachineConfig,
  buildTagFor,
  DEFAULT_BUILD_RECONCILER_POLICY,
  guestForPreset,
  imageRepositoryFor,
  isImageDigest,
  machineNameForDigest,
  parseImageSizeBytes,
  parseManifestDigest,
  pinnedImageRef,
  planBuildStart,
  planStuckAppRecovery,
  PUBLISHED_APP_INTERNAL_PORT,
  resolveBuildReconcilerPolicy,
} from '../build-core';

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('image references', () => {
  assert({
    given: 'a fly app name',
    should: 'push to that app’s own registry repo (Fly rejects any other name)',
    actual: imageRepositoryFor('pgs-app-abc'),
    expected: 'registry.fly.io/pgs-app-abc',
  });

  assert({
    given: 'a digest',
    should: 'pin the machine image by digest, never by tag',
    actual: pinnedImageRef('pgs-app-abc', DIGEST),
    expected: `registry.fly.io/pgs-app-abc@${DIGEST}`,
  });

  assert({
    given: 'a well-formed digest',
    should: 'accept it',
    actual: isImageDigest(DIGEST),
    expected: true,
  });

  assert({
    given: 'a truncated digest',
    should: 'reject it',
    actual: isImageDigest('sha256:abc'),
    expected: false,
  });

  assert({
    given: 'an uppercase-hex digest',
    should: 'reject it — registry digests are lowercase',
    actual: isImageDigest(`sha256:${'A'.repeat(64)}`),
    expected: false,
  });

  assert({
    given: 'a source ref carrying registry punctuation',
    should: 'sanitize it so it cannot retarget the push',
    actual: buildTagFor('workspaces/app:latest@evil'),
    expected: 'src-workspaces-app-latest-evil',
  });

  assert({
    given: 'a source ref that sanitizes to nothing',
    should: 'still produce a legal tag',
    actual: buildTagFor('///'),
    expected: 'src-unknown',
  });

  assert({
    given: 'a source ref longer than the tag limit',
    should: 'truncate rather than emit an illegal tag',
    actual: buildTagFor('x'.repeat(400)).length,
    expected: 104,
  });

  assert({
    given: 'a digest',
    should: 'derive a stable machine name from it, so a retried create converges',
    actual: machineNameForDigest(DIGEST),
    expected: 'srv-aaaaaaaaaaaa',
  });
});

describe('machine config', () => {
  const config = buildMachineConfig({
    flyAppName: 'pgs-app-abc',
    digest: DIGEST,
    guestPreset: 'shared-cpu-1x-512',
    publishedAppId: 'abc',
    env: { FOO: 'bar', PORT: '3000' },
  });

  assert({
    given: 'the v1 guest preset',
    should: 'size the machine at shared-1x/512MB',
    actual: guestForPreset('shared-cpu-1x-512'),
    expected: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
  });

  assert({
    given: 'a preset outside the approved set',
    should: 'refuse rather than default to a size nobody priced',
    actual: guestForPreset('performance-8x'),
    expected: null,
  });

  assert({
    given: 'an unknown preset',
    should: 'produce no config at all',
    actual: buildMachineConfig({
      flyAppName: 'pgs-app-abc',
      digest: DIGEST,
      guestPreset: 'performance-8x',
      publishedAppId: 'abc',
    }),
    expected: null,
  });

  assert({
    given: 'a built config',
    should: 'boot the pinned digest',
    actual: config?.image,
    expected: `registry.fly.io/pgs-app-abc@${DIGEST}`,
  });

  assert({
    given: 'caller env that tries to move the app off the routed port',
    should: 'override PORT with the contract port',
    actual: config?.env,
    expected: { FOO: 'bar', PORT: String(PUBLISHED_APP_INTERNAL_PORT) },
  });

  assert({
    given: 'a built config',
    should: 'expose 80/443 so fly-replay’s port matching can work',
    actual: (config?.services?.[0] as { ports?: unknown[] })?.ports,
    expected: [
      { port: 80, handlers: ['http'] },
      { port: 443, handlers: ['tls', 'http'] },
    ],
  });

  assert({
    given: 'a built config',
    should: 'let the proxy wake it but never stop it — our reaper owns the billing boundary',
    actual: {
      autostart: (config?.services?.[0] as { autostart?: unknown })?.autostart,
      autostop: (config?.services?.[0] as { autostop?: unknown })?.autostop,
    },
    expected: { autostart: true, autostop: 'off' },
  });

  assert({
    given: 'a built config',
    should: 'tag the machine with the app id and digest it serves',
    actual: config?.metadata,
    expected: { pagespace_published_app_id: 'abc', pagespace_image_digest: DIGEST },
  });
});

describe('reading back what was pushed', () => {
  assert({
    given: 'a manifest descriptor',
    should: 'return the digest',
    actual: parseManifestDigest(JSON.stringify({ digest: DIGEST, size: 12 })),
    expected: DIGEST,
  });

  assert({
    given: 'a descriptor whose digest is malformed',
    should: 'return null rather than pin an unverified image',
    actual: parseManifestDigest(JSON.stringify({ digest: 'sha256:nope' })),
    expected: null,
  });

  assert({
    given: 'unparseable output',
    should: 'return null',
    actual: parseManifestDigest('docker: command not found'),
    expected: null,
  });

  assert({
    given: 'a manifest',
    should: 'sum the config blob and every layer',
    actual: parseImageSizeBytes(
      JSON.stringify({ config: { size: 1000 }, layers: [{ size: 2000 }, { size: 3000 }] }),
    ),
    expected: 6000,
  });

  assert({
    given: 'a manifest with a non-numeric layer size',
    should: 'count that layer as zero rather than produce NaN',
    actual: parseImageSizeBytes(
      JSON.stringify({ config: { size: 10 }, layers: [{ size: 'big' }, { size: 5 }] }),
    ),
    expected: 15,
  });

  assert({
    given: 'an OCI index (several per-platform images)',
    should: 'return null — there is no single size to record',
    actual: parseImageSizeBytes(JSON.stringify({ manifests: [{ digest: DIGEST }] })),
    expected: null,
  });

  assert({
    given: 'unparseable output',
    should: 'return null rather than fail a deploy over a cost signal',
    actual: parseImageSizeBytes('<html>502</html>'),
    expected: null,
  });
});

describe('who may start a build', () => {
  assert({
    given: 'an app the provisioner just handed over',
    should: 'build immediately',
    actual: planBuildStart('building'),
    expected: { action: 'build' },
  });

  assert({
    given: 'a live app being redeployed',
    should: 'move it to building first',
    actual: planBuildStart('running'),
    expected: { action: 'promote' },
  });

  assert({
    given: 'a cold app being redeployed',
    should: 'move it to building first',
    actual: planBuildStart('stopped'),
    expected: { action: 'promote' },
  });

  assert({
    given: 'an app whose Fly app may not exist yet',
    should: 'refuse — a push would 404 on a repo with no app behind it',
    actual: planBuildStart('provisioning'),
    expected: { action: 'refuse', reason: 'still_provisioning' },
  });

  assert({
    given: 'an app mid blue/green swap',
    should: 'refuse — a second build would race the first over one machine',
    actual: planBuildStart('deploying'),
    expected: { action: 'refuse', reason: 'deploy_in_flight' },
  });

  assert({
    given: 'a credit-parked app',
    should: 'refuse to spend build minutes on it',
    actual: planBuildStart('parked'),
    expected: { action: 'refuse', reason: 'parked' },
  });

  assert({
    given: 'an app being torn down',
    should: 'refuse',
    actual: planBuildStart('destroying'),
    expected: { action: 'refuse', reason: 'being_destroyed' },
  });

  assert({
    given: 'a failed app',
    should: 'refuse — recovery goes through the provisioner’s explicit retry edge',
    actual: planBuildStart('failed'),
    expected: { action: 'refuse', reason: 'failed_needs_retry' },
  });
});

describe('recovering a stuck build', () => {
  const policy = DEFAULT_BUILD_RECONCILER_POLICY;

  assert({
    given: 'a stuck app with a recorded source and attempts left',
    should: 're-queue the build',
    actual: planStuckAppRecovery(
      { publishedAppId: 'a', status: 'building', sourceRef: 'ws/app', priorAttempts: 1 },
      policy,
    ),
    expected: { action: 'requeue', attempt: 2, sourceRef: 'ws/app' },
  });

  assert({
    given: 'a stuck deploy',
    should: 're-queue it too — the swap is safe to redo',
    actual: planStuckAppRecovery(
      { publishedAppId: 'a', status: 'deploying', sourceRef: 'ws/app', priorAttempts: 0 },
      policy,
    ),
    expected: { action: 'requeue', attempt: 1, sourceRef: 'ws/app' },
  });

  assert({
    given: 'a stuck app with no recorded source',
    should: 'fail it — there is nothing to re-run',
    actual: planStuckAppRecovery(
      { publishedAppId: 'a', status: 'building', sourceRef: null, priorAttempts: 0 },
      policy,
    ).action,
    expected: 'fail',
  });

  assert({
    given: 'a stuck app whose recorded source is empty',
    should: 'fail it rather than build an empty ref',
    actual: planStuckAppRecovery(
      { publishedAppId: 'a', status: 'building', sourceRef: '', priorAttempts: 0 },
      policy,
    ).action,
    expected: 'fail',
  });

  assert({
    given: 'an app that has burned its attempt budget',
    should: 'stop re-queueing it every horizon forever',
    actual: planStuckAppRecovery(
      {
        publishedAppId: 'a',
        status: 'building',
        sourceRef: 'ws/app',
        priorAttempts: policy.maxAttempts,
      },
      policy,
    ),
    expected: {
      action: 'fail',
      reason: 'attempts_exhausted',
      message:
        `Build stuck in 'building' after ${policy.maxAttempts} automatic recovery attempt(s); ` +
        'giving up',
    },
  });

  assert({
    given: 'one attempt below the budget',
    should: 'still re-queue — the bound is exclusive',
    actual: planStuckAppRecovery(
      {
        publishedAppId: 'a',
        status: 'building',
        sourceRef: 'ws/app',
        priorAttempts: policy.maxAttempts - 1,
      },
      policy,
    ).action,
    expected: 'requeue',
  });
});

describe('reconciler policy', () => {
  assert({
    given: 'no env overrides',
    should: 'use the defaults',
    actual: resolveBuildReconcilerPolicy({}),
    expected: DEFAULT_BUILD_RECONCILER_POLICY,
  });

  assert({
    given: 'valid overrides',
    should: 'take them',
    actual: resolveBuildReconcilerPolicy({
      APP_BUILD_STALE_THRESHOLD_MS: '60000',
      APP_BUILD_RECONCILE_BATCH: '5',
      APP_BUILD_MAX_RECONCILE_ATTEMPTS: '1',
    }),
    expected: { staleThresholdMs: 60000, batchLimit: 5, maxAttempts: 1 },
  });

  assert({
    given: 'a zero staleness horizon',
    should: 'fall back — zero would reclaim builds that just started',
    actual: resolveBuildReconcilerPolicy({ APP_BUILD_STALE_THRESHOLD_MS: '0' }).staleThresholdMs,
    expected: DEFAULT_BUILD_RECONCILER_POLICY.staleThresholdMs,
  });

  assert({
    given: 'a non-numeric override',
    should: 'fall back',
    actual: resolveBuildReconcilerPolicy({ APP_BUILD_RECONCILE_BATCH: 'lots' }).batchLimit,
    expected: DEFAULT_BUILD_RECONCILER_POLICY.batchLimit,
  });
});
