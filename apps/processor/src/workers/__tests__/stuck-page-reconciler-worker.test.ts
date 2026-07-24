/**
 * Shell tests for the stuck-page reconciler worker (#2159).
 *
 * The worker is the imperative shell around classifyStalePage: advisory-lock
 * the run, query pages stuck in 'pending'/'processing' with no live pg-boss
 * job (excluded inside the query itself, before LIMIT — see the "live-job
 * exclusion" test), then act on each decision (re-enqueue pull-verify / a
 * conditional mark-failed UPDATE) and alert on failures. All I/O is
 * injected, so these tests use fakes — no vi.mock of db modules needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    processor: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

const { mockSentryCaptureMessage } = vi.hoisted(() => ({ mockSentryCaptureMessage: vi.fn() }));
vi.mock('@sentry/node', () => ({
  captureMessage: mockSentryCaptureMessage,
}));

import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  runStuckPageReconciler,
  defaultReconcilerAlert,
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
  attempts?: Record<string, number>;
  /** pageId -> rowCount the mark-failed UPDATE reports (default 1 = succeeded). */
  failUpdateRowCounts?: Record<string, number>;
}): FakeDb {
  const queries: string[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]): Promise<QueryResult> => {
    queries.push(text);
    if (text.includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: data.locked ?? true }], rowCount: 1 };
    }
    if (text.includes('pg_advisory_unlock')) {
      return { rows: [], rowCount: null };
    }
    if (text.includes('UPDATE pages')) {
      const pageId = String(values?.[1]);
      const rowCount = data.failUpdateRowCounts?.[pageId] ?? 1;
      return { rows: [], rowCount };
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

  it('excludes pages with a live owning job inside the candidate query, before LIMIT', async () => {
    const db = makeFakeDb({ candidates: [candidate()] });
    const deps = makeDeps(db);

    await runStuckPageReconciler(deps);

    const candidatesQuery = db.queries.find((q) => q.includes('FROM pages'));
    expect(candidatesQuery).toContain('NOT EXISTS');
    expect(candidatesQuery).toContain('pgboss.job');
    expect(candidatesQuery).toContain('state IN (\'created\', \'retry\', \'active\')');
    // The live-job exclusion must be inside the same query as the LIMIT — a
    // separate post-filter would let a persistent front batch of live-job
    // pages crowd out genuinely orphaned pages ordered behind them.
    expect(candidatesQuery!.indexOf('NOT EXISTS')).toBeLessThan(candidatesQuery!.indexOf('LIMIT'));
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
    expect(deps.alert).not.toHaveBeenCalled();
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
    const updateQuery = db.queries.find((q) => q.includes('UPDATE pages'));
    expect(updateQuery).toContain('"processingStatus" IN (\'pending\', \'processing\')');
    expect(summary).toMatchObject({ failed: 1, skipped: 0 });
    expect(deps.alert).toHaveBeenCalledTimes(1);
    expect(deps.alert).toHaveBeenCalledWith(
      expect.stringContaining('1 page(s) failed'),
      expect.objectContaining({ failedPages: [{ pageId: 'page_1', reason: 'attempts-exhausted' }] }),
    );
  });

  it('marks a page with an invalid content hash failed instead of re-enqueueing', async () => {
    const db = makeFakeDb({ candidates: [candidate({ contentHash: 'not-a-hash' })] });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ failed: 1 });
    expect(deps.alert).toHaveBeenCalledTimes(1);
  });

  it('marks a page with a null content hash failed (not silently excluded from the scan)', async () => {
    const db = makeFakeDb({ candidates: [candidate({ contentHash: null })] });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ failed: 1 });
  });

  it('does not filter out null-contentHash pages from the SQL candidate scan', async () => {
    const db = makeFakeDb({ candidates: [] });
    const deps = makeDeps(db);

    await runStuckPageReconciler(deps);

    const candidatesQuery = db.queries.find((q) => q.includes('FROM pages'));
    expect(candidatesQuery).not.toContain('"filePath" IS NOT NULL');
  });

  it('treats a zero-row mark-failed update as skipped, not failed — the page resolved itself', async () => {
    const db = makeFakeDb({
      candidates: [candidate()],
      attempts: { page_1: 3 },
      failUpdateRowCounts: { page_1: 0 },
    });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(summary).toMatchObject({ failed: 0, skipped: 1 });
    expect(deps.alert).not.toHaveBeenCalled();
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
    expect(deps.alert).toHaveBeenCalledWith(
      expect.stringContaining('1 re-enqueue error(s)'),
      expect.anything(),
    );
  });

  it('isolates a mark-failed update failure — the batch continues and it is counted separately', async () => {
    const db = makeFakeDb({
      candidates: [candidate(), candidate({ id: 'page_2' })],
      attempts: { page_1: 3, page_2: 3 },
    });
    let calls = 0;
    db.client.query.mockImplementation(async (text: string, values?: unknown[]) => {
      db.queries.push(text);
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes('pg_advisory_unlock')) return { rows: [], rowCount: null };
      if (text.includes('UPDATE pages')) {
        calls += 1;
        if (calls === 1) throw new Error('connection blip');
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM pages')) return { rows: [candidate(), candidate({ id: 'page_2' })], rowCount: 2 };
      if (text.includes('reconcileAttempt')) {
        return { rows: [{ pageId: 'page_1', attempts: 3 }, { pageId: 'page_2', attempts: 3 }], rowCount: 2 };
      }
      throw new Error(`Unexpected query: ${text} ${JSON.stringify(values)}`);
    });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(summary).toMatchObject({ failed: 1, failUpdateErrors: 1 });
    expect(deps.alert).toHaveBeenCalledTimes(2); // one failedPages alert, one error-threshold alert
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

  it('returns an empty summary without querying job attempts when nothing is stuck', async () => {
    const db = makeFakeDb({ candidates: [] });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(summary).toMatchObject({ lockHeld: true, scanned: 0, reenqueued: 0, failed: 0 });
    expect(db.queries.some((q) => q.includes('reconcileAttempt'))).toBe(false);
  });

  it('skips a page whose recomputed age falls under the threshold (defensive; SQL should already exclude it)', async () => {
    const db = makeFakeDb({ candidates: [candidate({ ageMs: '1000' })] });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(deps.enqueuePullVerify).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 1, skipped: 1, reenqueued: 0, failed: 0 });
  });

  it('warns when the batch hits the configured batchLimit — more stuck pages remain', async () => {
    const db = makeFakeDb({ candidates: [candidate()] });
    const deps = makeDeps(db, {
      policy: { staleThresholdMs: 15 * 60 * 1000, maxReconcileAttempts: 3, batchLimit: 1 },
    });

    await runStuckPageReconciler(deps);

    expect(loggers.processor.warn).toHaveBeenCalledWith(expect.stringContaining('batch limit 1 hit'));
  });

  it('resolves the default policy from the environment when deps.policy is omitted', async () => {
    const originalEnv = { ...process.env };
    delete process.env.RECONCILER_STALE_MINUTES;
    delete process.env.RECONCILER_MAX_ATTEMPTS;
    delete process.env.RECONCILER_BATCH_LIMIT;
    try {
      // 20 minutes old clears the documented 15-minute default threshold.
      const db = makeFakeDb({ candidates: [candidate({ ageMs: String(20 * 60 * 1000) })] });
      const deps = makeDeps(db, { policy: undefined });

      const summary = await runStuckPageReconciler(deps);

      expect(deps.enqueuePullVerify).toHaveBeenCalledWith(
        expect.objectContaining({ reconcileAttempt: 1 }),
      );
      expect(summary).toMatchObject({ reenqueued: 1 });
    } finally {
      process.env = originalEnv;
    }
  });

  it('handles a non-Error rejection from enqueuePullVerify', async () => {
    const db = makeFakeDb({ candidates: [candidate()] });
    const deps = makeDeps(db, { enqueuePullVerify: vi.fn().mockRejectedValue('boom') });

    const summary = await runStuckPageReconciler(deps);

    expect(summary).toMatchObject({ enqueueErrors: 1 });
    expect(loggers.processor.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('handles a non-Error rejection from the mark-failed UPDATE', async () => {
    const db = makeFakeDb({ candidates: [candidate()], attempts: { page_1: 3 } });
    db.client.query.mockImplementation(async (text: string) => {
      db.queries.push(text);
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (text.includes('pg_advisory_unlock')) return { rows: [], rowCount: null };
      if (text.includes('UPDATE pages')) throw 'db offline';
      if (text.includes('FROM pages')) return { rows: [candidate()], rowCount: 1 };
      if (text.includes('reconcileAttempt')) {
        return { rows: [{ pageId: 'page_1', attempts: 3 }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const deps = makeDeps(db);

    const summary = await runStuckPageReconciler(deps);

    expect(summary).toMatchObject({ failUpdateErrors: 1, failed: 0 });
    expect(loggers.processor.warn).toHaveBeenCalledWith(expect.stringContaining('db offline'));
  });
});

describe('defaultReconcilerAlert', () => {
  it('logs an error and captures a Sentry message with the given context', () => {
    defaultReconcilerAlert('something is wrong', { pageIds: ['page_1'] });

    expect(loggers.processor.error).toHaveBeenCalledWith('something is wrong', {
      pageIds: ['page_1'],
    });
    expect(mockSentryCaptureMessage).toHaveBeenCalledWith('something is wrong', {
      level: 'error',
      extra: { pageIds: ['page_1'] },
    });
  });
});
