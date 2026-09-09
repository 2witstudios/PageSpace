/**
 * Stuck-build recovery, with the claim and the queue faked.
 *
 * The property worth pinning here is that recovery is BOUNDED and CLEAN: a stuck
 * app is re-queued rather than failed (a dead worker is not a broken app), an app
 * with nothing to re-run or no attempts left is failed rather than re-queued
 * forever, and a row whose enqueue failed stays CLAIMED so the next pass waits out
 * the lease instead of hammering whatever is broken.
 *
 * The build input comes from the INJECTED artifact source, never from the row —
 * `published_apps` records no source pointer, because the environment is what
 * answers "what is published". So the fixtures below vary `sources`, not a column.
 */
import { describe, it, expect } from 'vitest';
import type { PublishedApp, PublishedAppStatus } from '@pagespace/db/schema/published-apps';
import { runAppBuildReconciler, type BuildReconcilerDeps } from '../build-reconciler';
import { DEFAULT_BUILD_RECONCILER_POLICY } from '../build-core';

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
    imageDigest: null,
    imageSizeBytes: null,
    tier: 'metered',
    machineId: null,
    lastWakeAt: null,
    lastStopAt: null,
    lastError: null,
    claimedAt: new Date(0),
    claimedBy: 'token-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as PublishedApp;
}

function harness({
  apps = [app()],
  priorAttempts = 0,
  enqueueThrows = false,
  transitionOk = true,
  sources,
  resolveThrows = false,
}: {
  apps?: PublishedApp[];
  priorAttempts?: number;
  enqueueThrows?: boolean;
  transitionOk?: boolean;
  /** Per-app build input from the artifact source. Unlisted apps resolve to 'ws/app'. */
  sources?: Record<string, string | null>;
  resolveThrows?: boolean;
} = {}) {
  const claims: unknown[] = [];
  const enqueued: unknown[] = [];
  const failed: unknown[] = [];
  const released: { ids: string[]; token: string }[] = [];
  const resolved: string[] = [];

  const deps: BuildReconcilerDeps = {
    isEnabled: () => true,
    claim: async (args) => {
      claims.push(args);
      return { token: 'token-1', apps };
    },
    release: async (ids, token) => {
      released.push({ ids, token });
      return ids.length;
    },
    transition: async (publishedAppId, to, patch) => {
      failed.push({ publishedAppId, to, patch });
      return transitionOk
        ? { ok: true, app: app({ status: 'failed' }) }
        : { ok: false, reason: 'illegal_transition' };
    },
    countPriorAttempts: async () => priorAttempts,
    resolveSource: async (a) => {
      if (resolveThrows) throw new Error('artifact store unreachable');
      resolved.push(a.id);
      return sources && a.id in sources ? sources[a.id] : 'ws/app';
    },
    enqueueBuild: async (data) => {
      if (enqueueThrows) throw new Error('duplicate singleton');
      enqueued.push(data);
      return 'job-1';
    },
    log: () => {},
    policy: DEFAULT_BUILD_RECONCILER_POLICY,
  };

  return { deps, claims, enqueued, failed, released, resolved };
}

describe('the kill switch', () => {
  it('claims nothing when hosting is off', async () => {
    const h = harness();
    const summary = await runAppBuildReconciler({ ...h.deps, isEnabled: () => false });
    expect(summary.claimed).toBe(0);
    expect(h.claims).toEqual([]);
  });
});

describe('the claim', () => {
  it('asks for stuck statuses only, and pushes staleness INTO the query', async () => {
    const h = harness();
    await runAppBuildReconciler(h.deps);
    expect(h.claims).toEqual([
      {
        statuses: ['building', 'deploying'],
        limit: DEFAULT_BUILD_RECONCILER_POLICY.batchLimit,
        staleForMs: DEFAULT_BUILD_RECONCILER_POLICY.staleThresholdMs,
      },
    ]);
  });

  it('does nothing at all when nothing is stuck', async () => {
    const h = harness({ apps: [] });
    const summary = await runAppBuildReconciler(h.deps);
    expect(summary).toEqual({
      claimed: 0,
      requeued: 0,
      failed: 0,
      enqueueErrors: 0,
      transitionErrors: 0,
    });
    expect(h.released).toEqual([]);
  });
});

describe('an app whose worker died', () => {
  it('re-queues its build with the RE-RESOLVED source and the next attempt number', async () => {
    const h = harness({ priorAttempts: 1 });
    const summary = await runAppBuildReconciler(h.deps);
    // Asked the artifact source, rather than trusting a value the dead worker left
    // behind — a re-run must build whatever the env offers NOW.
    expect(h.resolved).toEqual(['app-1']);
    expect(h.enqueued).toEqual([
      { publishedAppId: 'app-1', sourceRef: 'ws/app', reconcileAttempt: 2 },
    ]);
    expect(summary.requeued).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('re-queues a stuck DEPLOY too — the swap is safe to redo', async () => {
    const h = harness({ apps: [app({ status: 'deploying', imageDigest: `sha256:${'3'.repeat(64)}` })] });
    const summary = await runAppBuildReconciler(h.deps);
    expect(summary.requeued).toBe(1);
  });

  it('releases the claim so the re-queued build is not blocked behind its own lease', async () => {
    const h = harness();
    await runAppBuildReconciler(h.deps);
    expect(h.released).toEqual([{ ids: ['app-1'], token: 'token-1' }]);
  });
});

describe('an app that cannot be recovered', () => {
  it('fails one whose source will not resolve rather than re-queueing an empty build', async () => {
    const h = harness({ sources: { 'app-1': null } });
    const summary = await runAppBuildReconciler(h.deps);
    expect(h.enqueued).toEqual([]);
    expect(summary.failed).toBe(1);
    expect(h.failed[0]).toMatchObject({ publishedAppId: 'app-1', to: 'failed' });
  });

  it('gives up once the attempt budget is spent', async () => {
    const h = harness({ priorAttempts: DEFAULT_BUILD_RECONCILER_POLICY.maxAttempts });
    const summary = await runAppBuildReconciler(h.deps);
    expect(summary).toMatchObject({ requeued: 0, failed: 1 });
    expect(h.released).toEqual([{ ids: ['app-1'], token: 'token-1' }]);
  });

  it('counts a refused fail-transition instead of pretending it landed', async () => {
    const h = harness({ sources: { 'app-1': null }, transitionOk: false });
    const summary = await runAppBuildReconciler(h.deps);
    expect(summary).toMatchObject({ failed: 0, transitionErrors: 1 });
    // Not settled: the row stays claimed, so the next pass waits out the lease.
    expect(h.released).toEqual([]);
  });
});

describe('when the artifact source itself is broken', () => {
  it('counts the failure and leaves the row CLAIMED — an unreachable store is not a missing artifact', async () => {
    const h = harness({ resolveThrows: true });
    const summary = await runAppBuildReconciler(h.deps);
    // Emphatically NOT `failed`: a resolver that throws says nothing about whether
    // the app has a promoted artifact, and failing on it would destroy a publish
    // over a transient outage.
    expect(summary).toMatchObject({ claimed: 1, requeued: 0, failed: 0, enqueueErrors: 1 });
    expect(h.failed).toEqual([]);
    expect(h.released).toEqual([]);
  });
});

describe('when the queue itself is broken', () => {
  it('counts the error and leaves the row CLAIMED rather than releasing it into a loop', async () => {
    const h = harness({ enqueueThrows: true });
    const summary = await runAppBuildReconciler(h.deps);
    expect(summary).toMatchObject({ claimed: 1, requeued: 0, enqueueErrors: 1 });
    expect(h.released).toEqual([]);
  });
});

describe('a mixed batch', () => {
  it('handles each app on its own merits and releases only what it settled', async () => {
    const h = harness({
      apps: [app({ id: 'a' }), app({ id: 'b' }), app({ id: 'c' })],
      sources: { b: null },
    });
    const summary = await runAppBuildReconciler(h.deps);
    expect(summary).toMatchObject({ claimed: 3, requeued: 2, failed: 1 });
    expect(h.released).toEqual([{ ids: ['a', 'b', 'c'], token: 'token-1' }]);
  });
});
