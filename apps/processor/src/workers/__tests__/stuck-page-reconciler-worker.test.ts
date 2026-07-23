/**
 * Shell tests for the stuck-page reconciler worker (#2159).
 *
 * The worker is the imperative shell around classifyStalePage: advisory-lock
 * the run, query pages stuck in 'pending'/'processing' with no live pg-boss
 * job, then act on each decision (re-enqueue pull-verify / mark failed) and
 * alert when pages had to be failed. All I/O is injected, so these tests use
 * fakes — no vi.mock of db modules needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    processor: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import {
  runStuckPageReconciler,
  type StuckPageReconcilerDeps,
} from '../stuck-page-reconciler-worker';

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

interface FakeDb {
  client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  queries: string[];
}

/** Routes queries by recognizable SQL fragments; order-independent. */
function makeFakeDb(data: {
  locked?: boolean;
  candidates?: Record<string, unknown>[];
  livePageIds?: string[];
  attempts?: Record<string, number>;
}): FakeDb {
  const queries: string[] = [];
  const query = vi.fn(async (text: string): Promise<QueryResult> => {
    queries.push(text);
    if (text.includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: data.locked ?? true }], rowCount: 1 };
    }
    if (text.includes('pg_advisory_unlock')) {
      return { rows: [], rowCount: null };
    }
    if (text.includes('FROM pages')) {
      return { rows: data.candidates ?? [], rowCount: (data.candidates ?? []).length };
    }
    if (text.includes('reconcileAttempt')) {
      const rows = Object.entries(data.attempts ?? {}).map(([pageId, attempts]) => ({
        pageId,
        attempts,
      }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('pgboss.job')) {
      const rows = (data.livePageIds ?? []).map((pageId) => ({ pageId }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected query: ${text}`);
  });
  return { client: { query, release: vi.fn() }, queries };
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'page_1',
    processingStatus: 'pending',
    contentHash: 'a'.repeat(64),
    ageMs: String(60 * 60 * 1000),
    ...overrides,
  };
}

function makeDeps(db: FakeDb, overrides: Partial<StuckPageReconcilerDeps> = {}): StuckPageReconcilerDeps {
  return {
    connect: vi.fn(async () => db.client),
    enqueuePullVerify: vi.fn(async () => 'job_1'),
    markPageFailed: vi.fn(async () => {}),
    alert: vi.fn(),
    policy: { staleThresholdMs: 15 * 60 * 1000, maxReconcileAttempts: 3, batchLimit: 50 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runStuckPageReconciler', () => {
  it('no-ops (and reports lockHeld=false) when another run holds the advisory lock', async () => {
    const db = makeFakeDb({ locked: false });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(summary.lockHeld).toBe(false);
    expect(summary.scanned).toBe(0);
    expect(deps.enqueuePullVerify).not.toHaveBeenCalled();
    expect(db.queries.some((q) => q.includes('FROM pages'))).toBe(false);
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });

  it('re-enqueues a stale pending page with no live job, tagged with attempt 1', async () => {
    const db = makeFakeDb({ candidates: [candidate()] });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).toHaveBeenCalledWith({
      pageId: 'page_1',
      contentHash: 'a'.repeat(64),
      reconcileAttempt: 1,
    });
    expect(summary).toMatchObject({ lockHeld: true, scanned: 1, reenqueued: 1, failed: 0 });
    expect(deps.markPageFailed).not.toHaveBeenCalled();
    expect(deps.alert).not.toHaveBeenCalled();
  });

  it('skips pages that still have a live pg-boss job', async () => {
    const db = makeFakeDb({ candidates: [candidate()], livePageIds: ['page_1'] });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 1, reenqueued: 0, failed: 0, skipped: 1 });
  });

  it('resumes the attempt count from prior reconciler-tagged jobs', async () => {
    const db = makeFakeDb({ candidates: [candidate()], attempts: { page_1: 2 } });
    const deps = makeDeps(db);

    await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).toHaveBeenCalledWith(
      expect.objectContaining({ reconcileAttempt: 3 }),
    );
  });

  it('marks a page failed and alerts once reconcile attempts are exhausted', async () => {
    const db = makeFakeDb({ candidates: [candidate()], attempts: { page_1: 3 } });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).not.toHaveBeenCalled();
    expect(deps.markPageFailed).toHaveBeenCalledTimes(1);
    expect(deps.markPageFailed).toHaveBeenCalledWith('page_1', expect.stringContaining('3'));
    expect(summary).toMatchObject({ failed: 1 });
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });

  it('marks a page with an invalid content hash failed instead of re-enqueueing', async () => {
    const db = makeFakeDb({ candidates: [candidate({ contentHash: 'not-a-hash' })] });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).not.toHaveBeenCalled();
    expect(deps.markPageFailed).toHaveBeenCalledWith('page_1', expect.any(String));
    expect(summary).toMatchObject({ failed: 1 });
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });

  it('handles a mixed batch independently — one enqueue failure does not stop the rest', async () => {
    const db = makeFakeDb({
      candidates: [candidate(), candidate({ id: 'page_2' }), candidate({ id: 'page_3' })],
    });
    const deps = makeDeps(db, {
      enqueuePullVerify: vi
        .fn()
        .mockRejectedValueOnce(new Error('duplicate or rejected'))
        .mockResolvedValue('job_x'),
    });

    const summary = await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({ scanned: 3, reenqueued: 2, enqueueErrors: 1 });
  });

  it('releases the advisory lock and the client even when the page scan throws', async () => {
    const db = makeFakeDb({});
    db.client.query.mockImplementation(async (text: string) => {
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes('pg_advisory_unlock')) return { rows: [], rowCount: null };
      throw new Error('db exploded');
    });
    const deps = makeDeps(db);

    await expect(runStuckPageReconciler(deps)).rejects.toThrow('db exploded');

    const ranUnlock = db.client.query.mock.calls.some(([q]) =>
      String(q).includes('pg_advisory_unlock'),
    );
    expect(ranUnlock).toBe(true);
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });

  it('returns an empty summary without querying job state when nothing is stuck', async () => {
    const db = makeFakeDb({ candidates: [] });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(summary).toMatchObject({ lockHeld: true, scanned: 0, reenqueued: 0, failed: 0 });
    expect(db.queries.some((q) => q.includes('pgboss.job'))).toBe(false);
  });
});
