import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
}));

import { resolveSessionPayerId, resolveEnvPayerId, lookupDriveOwnerId } from '../sandbox-payer';

/**
 * The ENV payer, tested directly rather than only through the reconcile.
 *
 * The rule is one line of code and the whole of an env's billing correctness:
 * the DRIVE OWNER, or nobody. `drive_envs.createdBy` is audit only, and a
 * future `?? createdBy` — or any other fallback added in sympathy with the
 * session resolver next door — must fail HERE, at the seam that states the
 * rule, not only somewhere downstream that happens to exercise it.
 */
describe('resolveEnvPayerId', () => {
  it('resolves the drive owner', async () => {
    const payer = await resolveEnvPayerId({
      driveId: 'drive-1',
      lookupDriveOwnerId: async (driveId) => `owner-of-${driveId}`,
    });

    expect(payer).toBe('owner-of-drive-1');
  });

  it('returns NULL when the drive cannot be resolved — there is no fallback, by design', async () => {
    // The deliberate divergence from `resolveSessionPayerId`, which falls back to
    // the session's own owner. An env has no owner column to fall back to, and
    // inventing one would bill a drive-owned machine to somebody who does not
    // own it. Callers SKIP the cycle instead.
    const payer = await resolveEnvPayerId({
      driveId: 'drive-gone',
      lookupDriveOwnerId: async () => null,
    });

    expect(payer).toBeNull();
  });
});

describe('resolveSessionPayerId', () => {
  it('bills the session owner directly for a global-assistant session (driveId null), with no lookup', async () => {
    const lookup = vi.fn();
    await expect(
      resolveSessionPayerId({ driveId: null, ownerId: 'owner-1', lookupDriveOwnerId: lookup }),
    ).resolves.toBe('owner-1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves to the session's ACTUAL drive owner when driveId is set — never the caller's surface tenant", async () => {
    const lookup = vi.fn(async () => 'real-drive-owner');
    await expect(
      resolveSessionPayerId({ driveId: 'session-drive-1', ownerId: 'session-owner-1', lookupDriveOwnerId: lookup }),
    ).resolves.toBe('real-drive-owner');
    expect(lookup).toHaveBeenCalledWith('session-drive-1');
  });

  it('falls back to the session ownerId when the drive lookup finds no owner (a stale read mid-delete)', async () => {
    const lookup = vi.fn(async () => null);
    await expect(
      resolveSessionPayerId({ driveId: 'vanished-drive', ownerId: 'owner-1', lookupDriveOwnerId: lookup }),
    ).resolves.toBe('owner-1');
  });

  it('is not a passthrough — a resolved drive owner beats a different session ownerId', async () => {
    const lookup = vi.fn(async () => 'other-owner');
    const a = await resolveSessionPayerId({ driveId: 'd', ownerId: 'a', lookupDriveOwnerId: lookup });
    const b = await resolveSessionPayerId({ driveId: 'd', ownerId: 'b', lookupDriveOwnerId: lookup });
    expect(a).toBe('other-owner');
    expect(b).toBe('other-owner');
  });
});

describe('lookupDriveOwnerId (real drives read)', () => {
  beforeEach(() => mockDb.select.mockReset());

  it("returns the drive's ownerId", async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ ownerId: 'owner-42' }],
        }),
      }),
    });
    await expect(lookupDriveOwnerId('drive-1')).resolves.toBe('owner-42');
  });

  it('returns null when the drive has no row', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    });
    await expect(lookupDriveOwnerId('missing')).resolves.toBeNull();
  });
});
