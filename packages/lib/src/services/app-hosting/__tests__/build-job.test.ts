/**
 * The build job's STATE MACHINE, with Docker, Fly and the database all faked.
 *
 * Every dependency is injected, so these tests assert the thing that actually
 * matters and that a live test could never pin reliably: WHAT THE ROW SAYS at each
 * step, and — on every failure path there is — that the machine currently serving
 * the app is never touched.
 */
import { describe, it, expect } from 'vitest';
import type { PublishedApp, PublishedAppStatus } from '@pagespace/db/schema/published-apps';
import {
  runAppBuildJob,
  type AppBuildDeps,
  type AppBuildOutcome,
  type MaterializedSource,
} from '../build-job';
import type { BuilderProcessResult, BuilderRunner } from '../image-builder';
import type { DeployerFlaps } from '../deployer';
import type { TransitionResult } from '../provisioner';

const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'2'.repeat(64)}`;

function app(overrides: Partial<PublishedApp> = {}): PublishedApp {
  return {
    id: 'app-1',
    envId: 'env-1',
    driveId: 'drive-1',
    ownerId: 'user-1',
    flyAppName: 'pgs-app-app-1',
    networkName: 'published-apps',
    subdomain: 'demo',
    status: 'building' as PublishedAppStatus,
    guestPreset: 'shared-cpu-1x-512',
    imageDigest: OLD_DIGEST,
    imageSizeBytes: 111,
    tier: 'metered',
    machineId: 'm-old',
    lastWakeAt: null,
    lastStopAt: null,
    lastError: null,
    claimedAt: null,
    claimedBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as PublishedApp;
}

interface Harness {
  deps: AppBuildDeps;
  log: string[];
  transitions: { to: string; patch: Record<string, unknown> }[];
  annotations: Record<string, unknown>[];
  /** Every source ref the job asked to be materialized, in order. */
  materialized: string[];
  cleanups: number;
}

function harness({
  row = app(),
  builderAvailable = true,
  buildFails = false,
  mintFails = false,
  materializeFails = false,
  sizeRaw = JSON.stringify({ config: { size: 100 }, layers: [{ size: 900 }] }),
  flapsOverrides = {},
  transitionResult,
}: {
  row?: PublishedApp;
  builderAvailable?: boolean;
  buildFails?: boolean;
  mintFails?: boolean;
  materializeFails?: boolean;
  sizeRaw?: string;
  flapsOverrides?: Partial<DeployerFlaps>;
  transitionResult?: (to: string) => TransitionResult | null;
} = {}): Harness {
  const log: string[] = [];
  const transitions: { to: string; patch: Record<string, unknown> }[] = [];
  const annotations: Record<string, unknown>[] = [];
  const materialized: string[] = [];
  const state = { cleanups: 0 };

  const runner: BuilderRunner = {
    async run(_command, args): Promise<BuilderProcessResult> {
      if (args[1] === 'version') {
        log.push('docker:probe');
        return builderAvailable
          ? { code: 0, stdout: 'v0.14.0', stderr: '' }
          : { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
      }
      if (args[0] === 'login') {
        log.push('docker:login');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[1] === 'build') {
        log.push('docker:build');
        return buildFails
          ? { code: 1, stdout: '', stderr: 'Dockerfile syntax error' }
          : { code: 0, stdout: '', stderr: '' };
      }
      if (args.includes('--format')) {
        return { code: 0, stdout: JSON.stringify({ digest: NEW_DIGEST }), stderr: '' };
      }
      return { code: 0, stdout: sizeRaw, stderr: '' };
    },
  };

  const flaps: DeployerFlaps = {
    createMachine: async () => {
      log.push('fly:create');
      return { id: 'm-new' };
    },
    waitForState: async () => {
      log.push('fly:wait');
    },
    exec: async () => {
      log.push('fly:health');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    deleteMachine: async (machineId) => {
      log.push(`fly:delete:${machineId}`);
    },
    ...flapsOverrides,
  };

  const deps: AppBuildDeps = {
    isEnabled: () => true,
    loadApp: async () => row,
    transition: async (_id, to, patch = {}) => {
      transitions.push({ to, patch: patch as Record<string, unknown> });
      log.push(`db:${to}`);
      const override = transitionResult?.(to);
      if (override) return override;
      return { ok: true, app: app({ ...row, status: to as PublishedAppStatus }) };
    },
    annotate: async (_id, fields) => {
      annotations.push(fields as Record<string, unknown>);
      log.push('db:annotate');
    },
    mintBuildToken: async () => {
      log.push('fly:mintToken');
      return mintFails ? null : 'FlyV1 fm2_token';
    },
    materializeSource: async (sourceRef): Promise<MaterializedSource> => {
      if (materializeFails) throw new Error('Source ref has no Dockerfile');
      materialized.push(sourceRef);
      log.push('source:materialize');
      return {
        contextDir: '/srv/build/app-1',
        dockerfile: '/srv/build/app-1/Dockerfile',
        cleanup: async () => {
          state.cleanups += 1;
          log.push('source:cleanup');
        },
      };
    },
    runner,
    flapsFor: () => flaps,
    log: () => {},
  };

  return {
    deps,
    log,
    transitions,
    annotations,
    materialized,
    get cleanups() {
      return state.cleanups;
    },
  };
}

const input = { publishedAppId: 'app-1', sourceRef: 'ws/app' };

/** The reason text of a failed outcome. Fails loudly on a success. */
function errorOf(result: AppBuildOutcome): string {
  if (result.ok) throw new Error('expected a failed build outcome, got a successful one');
  return 'error' in result ? result.error : `<no error text; reason=${result.reason}>`;
}

describe('the kill switch', () => {
  it('refuses before anything is read', async () => {
    const h = harness();
    const result = await runAppBuildJob(input, { ...h.deps, isEnabled: () => false });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
    expect(h.log).toEqual([]);
  });
});

describe('an app that is not there', () => {
  it('reports not_found without touching Fly', async () => {
    const h = harness();
    const result = await runAppBuildJob(input, { ...h.deps, loadApp: async () => null });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(h.log).toEqual([]);
  });
});

describe('statuses that must not start a build', () => {
  const cases: [PublishedAppStatus, string][] = [
    ['provisioning', 'still_provisioning'],
    ['deploying', 'deploy_in_flight'],
    ['parked', 'parked'],
    ['destroying', 'being_destroyed'],
    ['failed', 'failed_needs_retry'],
  ];
  for (const [status, reason] of cases) {
    it(`refuses a ${status} app with ${reason}, spending nothing`, async () => {
      const h = harness({ row: app({ status }) });
      expect(await runAppBuildJob(input, h.deps)).toEqual({ ok: false, reason });
      expect(h.log).toEqual([]);
      expect(h.transitions).toEqual([]);
    });
  }
});

describe('a successful build and deploy', () => {
  it('walks building → deploying → running and destroys the old machine last', async () => {
    const h = harness();
    const result = await runAppBuildJob(input, h.deps);

    expect(result).toEqual({
      ok: true,
      digest: NEW_DIGEST,
      machineId: 'm-new',
      imageSizeBytes: 1000,
    });
    expect(h.log).toEqual([
      'docker:probe',
      'fly:mintToken',
      'docker:login',
      'source:materialize',
      'docker:build',
      'source:cleanup',
      'db:deploying',
      'fly:create',
      'fly:wait',
      'fly:health',
      'db:running',
      'fly:delete:m-old',
    ]);
  });

  it('records the digest and its size in the same statement', async () => {
    const h = harness();
    await runAppBuildJob(input, h.deps);
    expect(h.transitions[0]).toEqual({
      to: 'deploying',
      patch: {
        imageDigest: NEW_DIGEST,
        imageSizeBytes: 1000,
        lastError: null,
      },
    });
  });

  it('points the row at the new machine BEFORE the old one is destroyed', async () => {
    const h = harness();
    await runAppBuildJob(input, h.deps);
    expect(h.transitions[1]).toEqual({
      to: 'running',
      patch: {
        machineId: 'm-new',
        imageDigest: NEW_DIGEST,
        imageSizeBytes: 1000,
        lastError: null,
      },
    });
    expect(h.log.indexOf('db:running')).toBeLessThan(h.log.indexOf('fly:delete:m-old'));
  });

  it('records a null size rather than failing when the image could not be measured', async () => {
    const h = harness({ sizeRaw: 'not json' });
    const result = await runAppBuildJob(input, h.deps);
    expect(result).toEqual({
      ok: true,
      digest: NEW_DIGEST,
      machineId: 'm-new',
      imageSizeBytes: null,
    });
    expect(h.transitions[0].patch.imageSizeBytes).toBe(null);
  });
});

describe('redeploying a live app', () => {
  it('moves it to building before anything is spent, carrying no source pointer', async () => {
    const h = harness({ row: app({ status: 'running' }) });
    await runAppBuildJob(input, h.deps);
    // No `sourceRef` in the patch, and none anywhere on the row: the environment
    // is what says what is published, and a copy here would be a second answer.
    expect(h.transitions[0]).toEqual({
      to: 'building',
      patch: { lastError: null },
    });
  });

  it('does nothing when the row moved underneath it', async () => {
    const h = harness({
      row: app({ status: 'running' }),
      transitionResult: (to) => (to === 'building' ? { ok: false, reason: 'illegal_transition' } : null),
    });
    expect(await runAppBuildJob(input, h.deps)).toEqual({ ok: false, reason: 'deploy_in_flight' });
    // The refused transition is the only thing that happened: no builder probe, no
    // credential, no build.
    expect(h.log).toEqual(['db:building']);
  });
});

describe('the build input', () => {
  it('is never persisted on the row — the job carries it, the env owns it', async () => {
    const h = harness();
    await runAppBuildJob(input, h.deps);
    // A successful build annotates nothing: `annotate` exists for `lastError` only.
    expect(h.annotations).toEqual([]);
    // And it reaches the builder from the job payload, not from a column.
    expect(h.materialized).toEqual(['ws/app']);
  });
});

describe('no Docker on this host', () => {
  it('leaves the app queued rather than blaming the user for our missing builder', async () => {
    const h = harness({ builderAvailable: false });
    const result = await runAppBuildJob(input, h.deps);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('builder_unavailable');
    // The row still says `building`: no transition at all, least of all to failed.
    expect(h.transitions).toEqual([]);
    expect(h.annotations[0].lastError).toContain('Cannot connect to the Docker daemon');
    // Nothing was spent: no credential minted, no source materialized, no build.
    expect(h.log).toEqual(['docker:probe', 'db:annotate']);
  });
});

describe('failures before the image exists', () => {
  it('fails the app when no deploy token can be minted, without logging in', async () => {
    const h = harness({ mintFails: true });
    const result = await runAppBuildJob(input, h.deps);
    expect(result.ok === false && result.reason).toBe('build_failed');
    expect(h.log).toEqual(['docker:probe', 'fly:mintToken', 'db:failed']);
  });

  it('fails the app when the source cannot be materialized', async () => {
    const h = harness({ materializeFails: true });
    const result = await runAppBuildJob(input, h.deps);
    expect(errorOf(result)).toContain('no Dockerfile');
    expect(h.log).not.toContain('docker:build');
  });

  it('fails the app when the build itself fails, and never deploys', async () => {
    const h = harness({ buildFails: true });
    const result = await runAppBuildJob(input, h.deps);
    expect(result.ok === false && result.reason).toBe('build_failed');
    expect(h.log).not.toContain('fly:create');
    expect(h.log).not.toContain('fly:delete:m-old');
  });

  it('always cleans the build context up, even when the build failed', async () => {
    const h = harness({ buildFails: true });
    await runAppBuildJob(input, h.deps);
    expect(h.cleanups).toBe(1);
  });

  it('puts the PREVIOUSLY SERVED digest back on the failed row', async () => {
    const h = harness({ buildFails: true });
    await runAppBuildJob(input, h.deps);
    expect(h.transitions).toEqual([
      {
        to: 'failed',
        patch: {
          imageDigest: OLD_DIGEST,
          imageSizeBytes: 111,
          lastError: expect.stringContaining('Dockerfile syntax error') as unknown as string,
        },
      },
    ]);
  });
});

describe('failures after the image exists', () => {
  it('destroys the new machine, keeps the old one, and restores the old digest', async () => {
    const h = harness({
      flapsOverrides: {
        exec: async () => ({ exitCode: 1, stdout: '', stderr: 'connection refused' }),
      },
    });
    const result = await runAppBuildJob(input, h.deps);

    expect(result.ok === false && result.reason).toBe('deploy_failed');
    expect(errorOf(result)).toContain('Deploy failed at health');
    expect(h.log).toContain('fly:delete:m-new');
    expect(h.log).not.toContain('fly:delete:m-old');

    const failure = h.transitions[h.transitions.length - 1];
    expect(failure.to).toBe('failed');
    expect(failure.patch.imageDigest).toBe(OLD_DIGEST);
    expect(failure.patch.imageSizeBytes).toBe(111);
  });

  it('rolls back when the row refuses to record the new machine', async () => {
    const h = harness({
      transitionResult: (to) => (to === 'running' ? { ok: false, reason: 'illegal_transition' } : null),
    });
    const result = await runAppBuildJob(input, h.deps);
    expect(result.ok === false && result.reason).toBe('deploy_failed');
    expect(h.log).toContain('fly:delete:m-new');
    expect(h.log).not.toContain('fly:delete:m-old');
  });

  it('fails the deploy on an unpriced guest preset before creating anything', async () => {
    const h = harness({ row: app({ guestPreset: 'performance-8x' }) });
    const result = await runAppBuildJob(input, h.deps);
    expect(errorOf(result)).toContain("Unknown guest preset 'performance-8x'");
    expect(h.log).not.toContain('fly:create');
  });

  it('still reports success when only the OLD machine could not be destroyed', async () => {
    const h = harness({
      flapsOverrides: {
        deleteMachine: async (machineId) => {
          if (machineId === 'm-old') throw new Error('machine is leased');
        },
      },
    });
    const result = await runAppBuildJob(input, h.deps);
    expect(result.ok).toBe(true);
  });
});

describe('a first deploy, with no machine yet', () => {
  it('creates one and destroys nothing', async () => {
    const h = harness({ row: app({ machineId: null, imageDigest: null, imageSizeBytes: null }) });
    const result = await runAppBuildJob(input, h.deps);
    expect(result.ok).toBe(true);
    expect(h.log.some((entry) => entry.startsWith('fly:delete:'))).toBe(false);
  });
});
