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
  conversationRevocationKickPayloads,
  workspaceRevocationKickPayloads,
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

const convA = 'ac6bzmkmd014706rfda898tp';
const convB = 'bd6bzmkmd014706rfda898tq';
const workspaceA = 'we6bzmkmd014706rfda898tr';

const makeDeps = (overrides: Partial<RevocationKickDeps> = {}): RevocationKickDeps => ({
  kick: vi.fn().mockResolvedValue({ success: true, kickedCount: 1, rooms: [] }),
  listDrivePageIds: vi.fn().mockResolvedValue([pageA, pageB]),
  // Mirrors the real dep: no pages, no conversations.
  listRevocableConversationIds: vi.fn(async ({ pageIds }: { pageIds: string[] }) =>
    pageIds.length === 0 ? [] : [convA, convB],
  ),
  listRevocableWorkspaceIds: vi.fn().mockResolvedValue([workspaceA]),
  ...overrides,
});

describe('kickForPagePermissionRevocation (shell)', () => {
  it('issues one kick per page room, plus the conversation content rooms that page carries', () => {
    // The conv: half is asserted in its own describe below; this pins that the
    // page rooms are still first and still exactly two.
    const deps = makeDeps();
    return kickForPagePermissionRevocation({ userId, pageId: pageA, reason: 'permission_revoked' }, deps).then(() => {
      const rooms = vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern);
      expect(rooms.slice(0, 2)).toEqual([pageA, `activity:page:${pageA}`]);
      expect(rooms).toHaveLength(4);
    });
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
    // Set-wise, not order-wise: the conv:/session: enumerations (asserted in
    // their own describe below) run alongside these, so their interleaving is
    // not a fact worth pinning.
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual(
      expect.arrayContaining([
        `drive:${driveId}`,
        `drive:${driveId}:calendar`,
        `activity:drive:${driveId}`,
        pageA,
        `activity:page:${pageA}`,
        pageB,
        `activity:page:${pageB}`,
      ]),
    );
  });

  it('is best-effort: never throws when page enumeration fails, still kicks drive rooms', async () => {
    const deps = makeDeps({ listDrivePageIds: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(
      kickForDriveMembershipRevocation({ userId, driveId, reason: 'member_removed' }, deps)
    ).resolves.toBeUndefined();
    const rooms = vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern);
    expect(rooms).toEqual(
      expect.arrayContaining([`drive:${driveId}`, `drive:${driveId}:calendar`, `activity:drive:${driveId}`]),
    );
    // No pages enumerated means no page rooms and no conversation rooms.
    expect(rooms).not.toContain(pageA);
    expect(rooms).not.toContain(`conv:${convA}`);
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

    // Drain the microtask queue up to (but not past) resolving pageIds. The
    // drive-scoped kicks — and the workspace kicks, which do not depend on the
    // page list either — must already have fired; nothing page-derived has.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const early = vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern);
    expect(early).toEqual(
      expect.arrayContaining([`drive:${driveId}`, `drive:${driveId}:calendar`, `activity:drive:${driveId}`]),
    );
    expect(early).not.toContain(pageA);

    resolvePageIds!([pageA]);
    await kickPromise;
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual(
      expect.arrayContaining([
        `drive:${driveId}`,
        `drive:${driveId}:calendar`,
        `activity:drive:${driveId}`,
        pageA,
        `activity:page:${pageA}`,
      ]),
    );
  });
});

/**
 * THE EPIC'S ROOMS WERE IN NO KICK SET (security review HIGH 3).
 *
 * Pre-epic, page-chat content rode the page room — which a page revocation
 * kicks. The Agent-Session SSoT epic moved content to `conv:<id>` and layout
 * to `session:<id>` and extended nothing, and outbound fan-out has no
 * re-check by design (room membership IS the authz). So:
 *
 *   Bob has view on page P. Alice shares conversation C on P; Bob joins
 *   `conv:C`. Alice revokes Bob's page access. Bob is evicted from the page
 *   and activity rooms — and keeps receiving every
 *   `conversation:message_created` with FULL message content, plus
 *   `workspace:updated` grids, until his socket happens to reconnect.
 *
 * Note the asymmetry the finding calls out: conversation UN-SHARE got a
 * bespoke wildcard kick; permission revocation — the wider case — did not.
 *
 * WHY ENUMERATION, not periodic re-auth. `/stream-join`'s 5s re-auth is the
 * right tool for a long-lived SUBSCRIPTION the server already polls; these
 * are ordinary rooms whose fan-out is the hot path, and re-authorizing every
 * `conv:`/`session:` member on a timer would put a permission query per
 * member per interval on the realtime server forever, to shorten a window
 * that a kick closes immediately. Enumeration costs two bounded queries ONCE,
 * at the revocation — which is also the moment the user is watching. The
 * per-event recheck in apps/realtime/src/per-event-auth.ts remains the actual
 * enforcement boundary either way; this only shrinks the stale window, as the
 * TRUST MODEL in ../realtime/rooms.ts requires.
 */
describe('conversationRevocationKickPayloads (pure)', () => {
  it('targets each conversation content room, carrying the page that lost access', () => {
    const payloads = conversationRevocationKickPayloads({
      userId,
      conversationIds: [convA, convB],
      pageId: pageA,
      reason: 'permission_revoked',
    });
    expect(payloads).toEqual([
      { userId, roomPattern: `conv:${convA}`, reason: 'permission_revoked', metadata: { pageId: pageA } },
      { userId, roomPattern: `conv:${convB}`, reason: 'permission_revoked', metadata: { pageId: pageA } },
    ]);
  });

  it('is empty when nothing was enumerated', () => {
    expect(conversationRevocationKickPayloads({ userId, conversationIds: [], reason: 'member_removed' })).toEqual([]);
  });
});

describe('workspaceRevocationKickPayloads (pure)', () => {
  it('targets each workspace layout room, carrying the drive that lost access', () => {
    expect(
      workspaceRevocationKickPayloads({ userId, workspaceIds: [workspaceA], driveId, reason: 'member_removed' }),
    ).toEqual([
      { userId, roomPattern: `session:${workspaceA}`, reason: 'member_removed', metadata: { driveId } },
    ]);
  });
});

describe('kickForPagePermissionRevocation — the conv: rooms', () => {
  it('evicts the conversation content rooms of the revoked page, not just the page room', async () => {
    const deps = makeDeps();
    await kickForPagePermissionRevocation({ userId, pageId: pageA, reason: 'permission_revoked' }, deps);

    expect(deps.listRevocableConversationIds).toHaveBeenCalledWith({ pageIds: [pageA], userId });
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern).sort()).toEqual(
      [pageA, `activity:page:${pageA}`, `conv:${convA}`, `conv:${convB}`].sort(),
    );
  });

  it('kicks the page rooms without waiting on conversation enumeration', async () => {
    let resolveIds: (ids: string[]) => void;
    const pending = new Promise<string[]>((resolve) => { resolveIds = resolve; });
    const deps = makeDeps({ listRevocableConversationIds: vi.fn().mockReturnValue(pending) });

    const kickPromise = kickForPagePermissionRevocation({ userId, pageId: pageA, reason: 'permission_revoked' }, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual([pageA, `activity:page:${pageA}`]);

    resolveIds!([convA]);
    await kickPromise;
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toContain(`conv:${convA}`);
  });

  it('is best-effort: conversation enumeration failing still leaves the page rooms kicked', async () => {
    const deps = makeDeps({ listRevocableConversationIds: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(
      kickForPagePermissionRevocation({ userId, pageId: pageA, reason: 'permission_revoked' }, deps),
    ).resolves.toBeUndefined();
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toEqual([pageA, `activity:page:${pageA}`]);
  });
});

describe('kickForDriveMembershipRevocation — the conv: and session: rooms', () => {
  it('evicts every conversation room in the drive\'s pages and every workspace room in the drive', async () => {
    const deps = makeDeps();
    await kickForDriveMembershipRevocation({ userId, driveId, driveName: 'Team', reason: 'member_removed' }, deps);

    expect(deps.listRevocableConversationIds).toHaveBeenCalledWith({ pageIds: [pageA, pageB], userId });
    expect(deps.listRevocableWorkspaceIds).toHaveBeenCalledWith({ driveId, userId });
    const rooms = vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern);
    expect(rooms).toContain(`conv:${convA}`);
    expect(rooms).toContain(`conv:${convB}`);
    expect(rooms).toContain(`session:${workspaceA}`);
  });

  it('kicks the session rooms even when page enumeration fails', async () => {
    const deps = makeDeps({ listDrivePageIds: vi.fn().mockRejectedValue(new Error('db down')) });
    await kickForDriveMembershipRevocation({ userId, driveId, reason: 'member_removed' }, deps);
    const rooms = vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern);
    expect(rooms).toContain(`session:${workspaceA}`);
    expect(rooms).not.toContain(`conv:${convA}`);
  });

  it('is best-effort: workspace enumeration failing never throws', async () => {
    const deps = makeDeps({ listRevocableWorkspaceIds: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(
      kickForDriveMembershipRevocation({ userId, driveId, reason: 'member_removed' }, deps),
    ).resolves.toBeUndefined();
    expect(vi.mocked(deps.kick).mock.calls.map(([p]) => p.roomPattern)).toContain(`drive:${driveId}`);
  });
});
