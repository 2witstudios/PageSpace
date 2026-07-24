/**
 * Revocation→kick hook (#2158): the ONE place a permission revocation turns
 * into Socket.IO room kicks, replacing the per-route kick calls that were
 * scattered across web API routes (and easy to forget on new revocation paths).
 *
 * Pure core (payload builders) is tested exhaustively; the imperative shell is
 * tested through injected deps — no DB, no network.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logging/logger-config', () => ({
  loggers: { realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  pageRevocationKickPayloads,
  driveScopedKickPayloads,
  driveRevocationKickPayloads,
  kickForPagePermissionRevocation,
  kickForDriveMembershipRevocation,
  type RevocationKickDeps,
} from '../revocation-kick';

const driveId = 'tz4a98xxat96iws9zmbrgj3a';
const pageA = 'pfh0haxfpzowht3oi213cqos';
const pageB = 'ldh0haxfpzowht3oi213cqot';
const userId = 'nc6bzmkmd014706rfda898to';

describe('pageRevocationKickPayloads (pure)', () => {
  it('targets the page room and the page activity room, carrying the reason', () => {
    const payloads = pageRevocationKickPayloads({ userId, pageId: pageA, reason: 'permission_revoked' });
    expect(payloads).toEqual([
      { userId, roomPattern: pageA, reason: 'permission_revoked', metadata: { pageId: pageA } },
      { userId, roomPattern: `activity:page:${pageA}`, reason: 'permission_revoked', metadata: { pageId: pageA } },
    ]);
  });

  it('supports the page_private reason', () => {
    const payloads = pageRevocationKickPayloads({ userId, pageId: pageA, reason: 'page_private' });
    expect(payloads.every((p) => p.reason === 'page_private')).toBe(true);
  });
});

describe('driveScopedKickPayloads (pure)', () => {
  it('targets only the drive, drive calendar, and drive activity rooms', () => {
    const payloads = driveScopedKickPayloads({ userId, driveId, driveName: 'Team', reason: 'member_removed' });
    expect(payloads.map((p) => p.roomPattern)).toEqual([
      `drive:${driveId}`,
      `drive:${driveId}:calendar`,
      `activity:drive:${driveId}`,
    ]);
    expect(payloads[0].metadata).toEqual({ driveId, driveName: 'Team' });
  });

  it('omits driveName from metadata when not provided', () => {
    const payloads = driveScopedKickPayloads({ userId, driveId, reason: 'member_removed' });
    expect(payloads[0].metadata).toEqual({ driveId });
  });
});

describe('driveRevocationKickPayloads (pure)', () => {
  it('targets drive, drive calendar, drive activity, and every page room in the drive', () => {
    const payloads = driveRevocationKickPayloads({
      userId,
      driveId,
      pageIds: [pageA, pageB],
      driveName: 'Team',
      reason: 'member_removed',
    });

    expect(payloads.map((p) => p.roomPattern)).toEqual([
      `drive:${driveId}`,
      `drive:${driveId}:calendar`,
      `activity:drive:${driveId}`,
      pageA,
      `activity:page:${pageA}`,
      pageB,
      `activity:page:${pageB}`,
    ]);
    expect(payloads.every((p) => p.userId === userId && p.reason === 'member_removed')).toBe(true);
    // Drive-level payloads carry the driveName so the client can explain the kick.
    expect(payloads[0].metadata).toEqual({ driveId, driveName: 'Team' });
    expect(payloads[3].metadata).toEqual({ pageId: pageA });
  });

  it('omits driveName from metadata when not provided and handles zero pages', () => {
    const payloads = driveRevocationKickPayloads({ userId, driveId, pageIds: [], reason: 'member_removed' });
    expect(payloads).toHaveLength(3);
    expect(payloads[0].metadata).toEqual({ driveId });
  });
});

const makeDeps = (overrides: Partial<RevocationKickDeps> = {}): RevocationKickDeps => ({
  kick: vi.fn().mockResolvedValue({ success: true, kickedCount: 1, rooms: [] }),
  listDrivePageIds: vi.fn().mockResolvedValue([pageA, pageB]),
  ...overrides,
});

describe('kickForPagePermissionRevocation (shell)', () => {
  it('issues one kick per page room', async () => {
    const deps = makeDeps();
    await kickForPagePermissionRevocation({ userId, pageId: pageA, reason: 'permission_revoked' }, deps);
    expect(deps.kick).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual([pageA, `activity:page:${pageA}`]);
  });

  it('is best-effort: never throws when a kick fails', async () => {
    const deps = makeDeps({ kick: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(
      kickForPagePermissionRevocation({ userId, pageId: pageA, reason: 'permission_revoked' }, deps)
    ).resolves.toBeUndefined();
  });
});

describe('kickForDriveMembershipRevocation (shell)', () => {
  it('enumerates the drive pages and kicks every drive + page room', async () => {
    const deps = makeDeps();
    await kickForDriveMembershipRevocation({ userId, driveId, driveName: 'Team', reason: 'member_removed' }, deps);

    expect(deps.listDrivePageIds).toHaveBeenCalledWith(driveId);
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual([
      `drive:${driveId}`,
      `drive:${driveId}:calendar`,
      `activity:drive:${driveId}`,
      pageA,
      `activity:page:${pageA}`,
      pageB,
      `activity:page:${pageB}`,
    ]);
  });

  it('is best-effort: never throws when page enumeration fails, still kicks drive rooms', async () => {
    const deps = makeDeps({ listDrivePageIds: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(
      kickForDriveMembershipRevocation({ userId, driveId, reason: 'member_removed' }, deps)
    ).resolves.toBeUndefined();
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual([
      `drive:${driveId}`,
      `drive:${driveId}:calendar`,
      `activity:drive:${driveId}`,
    ]);
  });

  it('is best-effort: never throws when kicks fail', async () => {
    const deps = makeDeps({ kick: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(
      kickForDriveMembershipRevocation({ userId, driveId, reason: 'member_removed' }, deps)
    ).resolves.toBeUndefined();
  });

  it('kicks the drive-scoped rooms without waiting on page enumeration', async () => {
    // "Immediately revoke real-time access" — the drive/calendar/activity
    // kicks don't need the page list, so they must not queue behind an
    // unrelated DB round-trip. Proven with a deferred listDrivePageIds: by
    // the time it resolves, the drive-scoped kicks must already have fired.
    let resolvePageIds: (ids: string[]) => void;
    const pageIdsPromise = new Promise<string[]>((resolve) => { resolvePageIds = resolve; });
    const deps = makeDeps({ listDrivePageIds: vi.fn().mockReturnValue(pageIdsPromise) });

    const kickPromise = kickForDriveMembershipRevocation({ userId, driveId, reason: 'member_removed' }, deps);

    // Drain the microtask queue up to (but not past) resolving pageIds.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual([
      `drive:${driveId}`,
      `drive:${driveId}:calendar`,
      `activity:drive:${driveId}`,
    ]);

    resolvePageIds!([pageA]);
    await kickPromise;
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual([
      `drive:${driveId}`,
      `drive:${driveId}:calendar`,
      `activity:drive:${driveId}`,
      pageA,
      `activity:page:${pageA}`,
    ]);
  });
});
