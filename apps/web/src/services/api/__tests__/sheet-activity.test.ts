/**
 * `logSheetCellActivity` must never throw.
 *
 * Every caller runs it AFTER the cell write has committed. Rethrowing turned a
 * successful write into a 500, which invites the agent to retry an edit that
 * already landed — double-applying it. The write is the user's data; the
 * activity entry is our bookkeeping, and losing the latter must not corrupt
 * the former.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const transaction = vi.fn();
vi.mock('@pagespace/db/db', () => ({ db: { transaction: (...args: unknown[]) => transaction(...args) } }));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({ logActivityWithTx: vi.fn() }));
vi.mock('@pagespace/lib/monitoring/change-group', () => ({ createChangeGroupId: () => 'cg_test' }));

const error = vi.fn();
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: (...a: unknown[]) => error(...a) } } }));

import { logSheetCellActivity } from '../sheet-activity';

const input = {
  pageId: 'p1',
  driveId: 'd1',
  userId: 'u1',
  metadata: { source: 'mcp' },
};

describe('logSheetCellActivity', () => {
  beforeEach(() => {
    transaction.mockReset();
    error.mockReset();
  });

  it('swallows and logs a failure to write the activity row', async () => {
    transaction.mockRejectedValue(new Error('activity insert failed'));

    await expect(logSheetCellActivity(input)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'Failed to log sheet cell activity',
      expect.any(Error),
      expect.objectContaining({ pageId: 'p1' }),
    );
  });

  it('swallows and logs a failure inside the deferred workflow trigger', async () => {
    // The trigger fires after commit, so the write is untouchable by then.
    transaction.mockResolvedValue(() => {
      throw new Error('workflow dispatch failed');
    });

    await expect(logSheetCellActivity(input)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'Sheet cell activity workflow trigger failed',
      expect.any(Error),
      expect.objectContaining({ pageId: 'p1' }),
    );
  });

  it('returns normally when logging succeeds', async () => {
    const trigger = vi.fn();
    transaction.mockResolvedValue(trigger);

    await logSheetCellActivity(input);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});
