/**
 * @scaffold — retention-engine cleanup functions accept `db` as a parameter,
 * but the mock still reproduces the ORM delete().where().returning() chain
 * shape. Assertions verify the observable CleanupResult contract and the
 * correct table reference, not internal chaining.
 *
 * REVIEW: once a RetentionRepository seam wraps these queries, replace
 * chain mocks with repository-level mocks and promote to contract tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _op: 'and', conditions: args }),
  lt: (col: unknown, val: unknown) => ({ _op: 'lt', col, val }),
  eq: (col: unknown, val: unknown) => ({ _op: 'eq', col, val }),
  isNotNull: (col: unknown) => ({ _op: 'isNotNull', col }),
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  verificationTokens: { id: 'vt.id', expiresAt: 'vt.expiresAt' },
  socketTokens: { id: 'st.id', expiresAt: 'st.expiresAt' },
  emailUnsubscribeTokens: { id: 'eut.id', expiresAt: 'eut.expiresAt' },
}));
vi.mock('@pagespace/db/schema/dashboard', () => ({
  pulseSummaries: { id: 'ps.id', expiresAt: 'ps.expiresAt' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  pagePermissions: { id: 'pp.id', expiresAt: 'pp.expiresAt' },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: { id: 'aul.id', expiresAt: 'aul.expiresAt' },
}));
vi.mock('@pagespace/db/schema/sessions', () => ({
  sessions: { id: 'sessions.id', expiresAt: 'sessions.expiresAt' },
}));
vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamFrames: { messageId: 'asf.messageId', createdAt: 'asf.createdAt' },
}));
vi.mock('@pagespace/db/schema/versioning', () => ({
  pageVersions: { id: 'pv.id', expiresAt: 'pv.expiresAt', isPinned: 'pv.isPinned' },
  driveBackups: { id: 'db.id', expiresAt: 'db.expiresAt', isPinned: 'db.isPinned' },
}));

vi.mock('./monitoring-retention', () => ({
  runMonitoringRetentionCleanup: vi.fn().mockResolvedValue([
    { table: 'api_metrics', deleted: 0 },
    { table: 'system_logs', deleted: 0 },
  ]),
}));

import {
  cleanupExpiredSessions,
  cleanupExpiredVerificationTokens,
  cleanupExpiredSocketTokens,
  cleanupExpiredEmailUnsubscribeTokens,
  cleanupExpiredPulseSummaries,
  cleanupExpiredPageVersions,
  cleanupExpiredDriveBackups,
  cleanupExpiredPagePermissions,
  cleanupExpiredAiUsageLogs,
  cleanupAbandonedStreamFrames,
  runRetentionCleanup,
} from './retention-engine';

import { verificationTokens, socketTokens, emailUnsubscribeTokens } from '@pagespace/db/schema/auth';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import { pagePermissions } from '@pagespace/db/schema/members';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { sessions } from '@pagespace/db/schema/sessions';
import { pageVersions, driveBackups } from '@pagespace/db/schema/versioning';
import { aiStreamFrames } from '@pagespace/db/schema/ai-streams';

/**
 * Creates a mock DB that captures which table and condition were passed,
 * allowing assertions on the contract boundary rather than internal chaining.
 */
// `rows` is only ever counted, never read — the sweeps differ in which key they RETURNING
// (`ai_stream_frames` has no `id`; its primary key is composite), so the shape stays open.
function createMockDb(rows: Record<string, string>[] = []) {
  const captured = { table: null as unknown, condition: null as unknown };
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn((cond: unknown) => {
    captured.condition = cond;
    return { returning };
  });
  const deleteFn = vi.fn((tbl: unknown) => {
    captured.table = tbl;
    return { where };
  });
  return { db: { delete: deleteFn } as never, captured, deleteFn, returning };
}

function createFailingDb(error: Error) {
  const returning = vi.fn().mockRejectedValue(error);
  const where = vi.fn().mockReturnValue({ returning });
  return { delete: vi.fn().mockReturnValue({ where }) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cleanupExpiredSessions', () => {
  it('given_expiredRowsExist_returnsTableNameAndDeletedCount', async () => {
    const { db, deleteFn } = createMockDb([{ id: '1' }, { id: '2' }]);

    const result = await cleanupExpiredSessions(db);

    expect(result).toEqual({ table: 'sessions', deleted: 2 });
    expect(deleteFn).toHaveBeenCalledWith(sessions);
  });

  it('given_noExpiredRows_returnsZeroDeleted', async () => {
    const { db } = createMockDb([]);

    const result = await cleanupExpiredSessions(db);

    expect(result).toEqual({ table: 'sessions', deleted: 0 });
  });

  it('given_databaseError_propagatesWithoutCatching', async () => {
    const db = createFailingDb(new Error('connection lost'));

    await expect(cleanupExpiredSessions(db)).rejects.toThrow('connection lost');
  });
});

describe('cleanupExpiredVerificationTokens', () => {
  it('given_expiredTokens_deletesFromCorrectTable', async () => {
    const { db, deleteFn } = createMockDb([{ id: '1' }]);

    const result = await cleanupExpiredVerificationTokens(db);

    expect(result).toEqual({ table: 'verification_tokens', deleted: 1 });
    expect(deleteFn).toHaveBeenCalledWith(verificationTokens);
  });

  it('given_databaseError_propagates', async () => {
    const db = createFailingDb(new Error('timeout'));
    await expect(cleanupExpiredVerificationTokens(db)).rejects.toThrow('timeout');
  });
});

describe('cleanupExpiredSocketTokens', () => {
  it('given_expiredTokens_deletesFromCorrectTable', async () => {
    const { db, deleteFn } = createMockDb([{ id: '1' }]);

    const result = await cleanupExpiredSocketTokens(db);

    expect(result).toEqual({ table: 'socket_tokens', deleted: 1 });
    expect(deleteFn).toHaveBeenCalledWith(socketTokens);
  });
});

describe('cleanupExpiredEmailUnsubscribeTokens', () => {
  it('given_noExpiredTokens_returnsZero', async () => {
    const { db, deleteFn } = createMockDb([]);

    const result = await cleanupExpiredEmailUnsubscribeTokens(db);

    expect(result).toEqual({ table: 'email_unsubscribe_tokens', deleted: 0 });
    expect(deleteFn).toHaveBeenCalledWith(emailUnsubscribeTokens);
  });
});

describe('cleanupExpiredPulseSummaries', () => {
  it('given_multipleExpired_returnsCorrectCount', async () => {
    const { db, deleteFn } = createMockDb([{ id: '1' }, { id: '2' }, { id: '3' }]);

    const result = await cleanupExpiredPulseSummaries(db);

    expect(result).toEqual({ table: 'pulse_summaries', deleted: 3 });
    expect(deleteFn).toHaveBeenCalledWith(pulseSummaries);
  });
});

describe('cleanupExpiredPageVersions', () => {
  it('given_expiredUnpinnedVersions_deletesAndReturnsCount', async () => {
    const { db, deleteFn, captured } = createMockDb([{ id: '1' }]);

    const result = await cleanupExpiredPageVersions(db);

    expect(result).toEqual({ table: 'page_versions', deleted: 1 });
    expect(deleteFn).toHaveBeenCalledWith(pageVersions);
    // The condition must include an AND (expiry + isPinned=false) to protect pinned versions
    expect(captured.condition).toEqual(
      expect.objectContaining({ _op: 'and' })
    );
  });

  it('given_databaseError_propagates', async () => {
    const db = createFailingDb(new Error('deadlock'));
    await expect(cleanupExpiredPageVersions(db)).rejects.toThrow('deadlock');
  });
});

describe('cleanupExpiredDriveBackups', () => {
  it('given_expiredUnpinnedBackups_deletesAndReturnsCount', async () => {
    const { db, deleteFn, captured } = createMockDb([{ id: '1' }]);

    const result = await cleanupExpiredDriveBackups(db);

    expect(result).toEqual({ table: 'drive_backups', deleted: 1 });
    expect(deleteFn).toHaveBeenCalledWith(driveBackups);
    // Must use AND condition to protect pinned backups
    expect(captured.condition).toEqual(
      expect.objectContaining({ _op: 'and' })
    );
  });
});

describe('cleanupExpiredPagePermissions', () => {
  it('given_expiredPermissions_deletesWithNotNullGuard', async () => {
    const { db, deleteFn, captured } = createMockDb([{ id: '1' }]);

    const result = await cleanupExpiredPagePermissions(db);

    expect(result).toEqual({ table: 'page_permissions', deleted: 1 });
    expect(deleteFn).toHaveBeenCalledWith(pagePermissions);
    // Must guard with isNotNull(expiresAt) to avoid deleting permanent permissions
    expect(captured.condition).toEqual(
      expect.objectContaining({ _op: 'and' })
    );
  });
});

describe('cleanupExpiredAiUsageLogs', () => {
  it('given_expiredLogs_deletesWithNotNullGuard', async () => {
    const { db, deleteFn, captured } = createMockDb([{ id: '1' }, { id: '2' }]);

    const result = await cleanupExpiredAiUsageLogs(db);

    expect(result).toEqual({ table: 'ai_usage_logs', deleted: 2 });
    expect(deleteFn).toHaveBeenCalledWith(aiUsageLogs);
    expect(captured.condition).toEqual(
      expect.objectContaining({ _op: 'and' })
    );
  });
});

/**
 * The durable AI frame log's BACKSTOP.
 *
 * `ai_stream_frames` normally clears itself: the writer deletes a message's log once a
 * terminal `messages` row for it is confirmed. This sweep covers the case where neither the
 * generation's own save nor a crash recovery ever ran — otherwise those frames are message
 * CONTENT sitting in a table with no reader and no expiry.
 */
describe('cleanupAbandonedStreamFrames', () => {
  it('given_abandonedFrames_deletesThemByAge', async () => {
    const { db, deleteFn } = createMockDb([{ messageId: 'm1' }, { messageId: 'm2' }]);

    const result = await cleanupAbandonedStreamFrames(db);

    expect(result).toEqual({ table: 'ai_stream_frames', deleted: 2 });
    expect(deleteFn).toHaveBeenCalledWith(aiStreamFrames);
  });

  it('given_abandonedFrames_agesOnCreatedAt_notAnExpiresAtColumn', async () => {
    // The table carries no expiry stamp — a frame does not know when it stops being needed,
    // only when it was written. `created_at` is also its only index.
    const { db, captured } = createMockDb([]);

    await cleanupAbandonedStreamFrames(db);

    expect(captured.condition).toEqual(
      expect.objectContaining({ _op: 'lt', col: 'asf.createdAt' })
    );
  });

  it('given_abandonedFrames_cutoffIsExactlyOneDayBack_soADelayedRecoveryStillFindsItsFrames', async () => {
    // A dead stream is materialized well inside two hours, but only when something LOOKS —
    // a poll, the next send, a Stop. That trigger can be arbitrarily delayed, so the window
    // has to outlast a user who closes the tab and comes back tomorrow.
    //
    // FROZEN CLOCK, so this pins the constant exactly instead of bracketing it. The first
    // version of this test read the clock BEFORE the call and asserted `before - cutoff >=
    // 24h` — but the sweep derives its cutoff from a LATER `Date.now()`, so that quantity is
    // `24h - elapsed` and the assertion only held while elapsed rounded to 0ms. It passed
    // locally and would have flaked in CI (review finding — coderabbitai, PR #2409). A
    // bracket around a real clock would fix the flake; freezing the clock also makes the
    // assertion say what it means.
    vi.useFakeTimers();
    try {
      const now = new Date('2026-08-14T12:00:00.000Z');
      vi.setSystemTime(now);
      const { db, captured } = createMockDb([]);

      await cleanupAbandonedStreamFrames(db);

      const cutoff = (captured.condition as { val: Date }).val;
      expect(cutoff.toISOString()).toBe('2026-08-13T12:00:00.000Z');
      expect(now.getTime() - cutoff.getTime()).toBe(24 * 60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runRetentionCleanup', () => {
  it('given_allCleanupsSucceed_returnsResultsForAll14Tables', async () => {
    const { db } = createMockDb([]);

    const results = await runRetentionCleanup(db);

    expect(results).toHaveLength(14);
  });

  it('given_allCleanupsSucceed_includesBothExpiryAndMonitoringTables', async () => {
    const { db } = createMockDb([]);

    const results = await runRetentionCleanup(db);
    const tableNames = results.map(r => r.table).sort();

    expect(tableNames).toEqual([
      'ai_stream_frames',
      'ai_usage_logs',
      'api_metrics',
      'conversations',
      'drive_backups',
      'email_unsubscribe_tokens',
      'messages',
      'page_permissions',
      'page_versions',
      'pulse_summaries',
      'sessions',
      'socket_tokens',
      'system_logs',
      'verification_tokens',
    ]);
  });

  it('given_allCleanupsSucceed_everyResultHasValidStructure', async () => {
    const { db } = createMockDb([]);

    const results = await runRetentionCleanup(db);

    for (const result of results) {
      expect(typeof result.table).toBe('string');
      expect(typeof result.deleted).toBe('number');
      expect(result.deleted).toBe(0);
    }
  });

  it('given_databaseError_rejectsWithOriginalError', async () => {
    const db = createFailingDb(new Error('connection refused'));

    await expect(runRetentionCleanup(db)).rejects.toThrow('connection refused');
  });
});
