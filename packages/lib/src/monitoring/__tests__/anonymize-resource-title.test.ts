/**
 * Regression test for #541: after logActivity writes an account_delete row
 * carrying the deleted user's email in resourceTitle,
 * activityLogRepository.anonymizeForUser must null it — and the row's
 * tamper-evident hash must still validate, since resourceTitle is excluded
 * from HashableLogData (see serializeLogDataForHash below).
 *
 * Only @pagespace/db/db is faked (in-memory table, same pattern as
 * hash-chain-verifier.test.ts); logActivity and anonymizeForUser run for
 * real, so this proves the actual fix rather than a mock of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let activityLogRows: Array<Record<string, unknown>> = [];

vi.mock('@pagespace/db/db', () => ({
  db: {
    transaction: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        query: {
          activityLogs: {
            // Only one row is ever inserted before this is consulted here,
            // so "most recent" is simply "last pushed".
            findFirst: vi.fn().mockImplementation(async () =>
              activityLogRows.length > 0 ? activityLogRows[activityLogRows.length - 1] : null
            ),
          },
        },
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation(async (vals: Record<string, unknown>) => {
            activityLogRows.push({ ...vals });
          }),
        }),
      };
      return cb(tx);
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((setVals: Record<string, unknown>) => ({
        where: vi.fn().mockImplementation(async () => {
          for (const row of activityLogRows) {
            Object.assign(row, setVals);
          }
        }),
      })),
    }),
  },
}));

import { logActivity, computeLogHash } from '../activity-logger';
import { activityLogRepository } from '../../repositories/activity-log-repository';
import { createAnonymizedActorEmail } from '../../compliance/anonymize';

describe('anonymizeForUser + logActivity integration (#541)', () => {
  beforeEach(() => {
    activityLogRows = [];
    vi.clearAllMocks();
  });

  it('nulls resourceTitle without breaking the hash chain', async () => {
    const userId = 'user-1';

    await logActivity({
      userId,
      actorEmail: 'actor@test.com',
      actorDisplayName: 'Actor',
      operation: 'account_delete',
      resourceType: 'user',
      resourceId: userId,
      resourceTitle: 'leaked@example.com',
      driveId: null,
    });

    const anonymizedEmail = createAnonymizedActorEmail(userId);
    const result = await activityLogRepository.anonymizeForUser(userId, anonymizedEmail);
    expect(result.success).toBe(true);

    const row = activityLogRows.find((r) => r.operation === 'account_delete');
    expect(row).toBeDefined();
    if (!row) throw new Error('unreachable');

    // (a) PII scrubbed
    expect(row.resourceTitle).toBeNull();

    // (c) actor identity still anonymized, same as before this fix
    expect(row.actorEmail).toBe(anonymizedEmail);
    expect(row.actorDisplayName).toBe('Deleted User');

    // (b) hash chain still validates — resourceTitle is excluded from
    // HashableLogData, so nulling it must not change the stored hash.
    const previousHash = (row.previousLogHash as string | null) ?? (row.chainSeed as string | null) ?? '';
    const recomputed = computeLogHash(
      {
        id: row.id as string,
        timestamp: row.timestamp as Date,
        operation: row.operation as string,
        resourceType: row.resourceType as string,
        resourceId: row.resourceId as string,
        driveId: row.driveId as string | null,
        pageId: row.pageId as string | undefined,
        contentSnapshot: row.contentSnapshot as string | undefined,
        previousValues: row.previousValues as Record<string, unknown> | undefined,
        newValues: row.newValues as Record<string, unknown> | undefined,
        metadata: row.metadata as Record<string, unknown> | undefined,
      },
      previousHash
    );
    expect(recomputed).toBe(row.logHash);
  });
});
