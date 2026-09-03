import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// callerCanViewUser — relationship scoping for /api/users/find (L1).
//
// Mocked at the DB seam: each db.select() consumes the next queued result set,
// in the order the route issues them:
//   1. accepted-connection check
//   2. caller's owned drives          (getUserDriveIds)
//   3. caller's member drives         (getUserDriveIds)
//   4. target shared-membership check
//   5. target shared-ownership check
// ============================================================================

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn() } }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  ne: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  ilike: vi.fn(),
  exists: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({ drives: { id: 'drives.id', ownerId: 'drives.ownerId' } }));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    userId: 'driveMembers.userId',
    driveId: 'driveMembers.driveId',
    acceptedAt: 'driveMembers.acceptedAt',
  },
  userProfiles: {
    userId: 'userProfiles.userId',
    username: 'userProfiles.username',
    displayName: 'userProfiles.displayName',
    bio: 'userProfiles.bio',
    avatarUrl: 'userProfiles.avatarUrl',
  },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id', emailVerified: 'users.emailVerified' },
}));
vi.mock('@pagespace/db/schema/social', () => ({
  connections: {
    status: 'connections.status',
    user1Id: 'connections.user1Id',
    user2Id: 'connections.user2Id',
  },
}));

import { callerCanViewUser, searchRelatedProfilesByName } from '../visibility';
import { db } from '@pagespace/db/db';
import { eq, ne, isNotNull, ilike, exists } from '@pagespace/db/operators';

function queueSelectResults(results: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation((() => {
    const result = results[i++] ?? [];
    const terminal = Promise.resolve(result) as Promise<unknown[]> & {
      limit: () => Promise<unknown[]>;
    };
    terminal.limit = () => Promise.resolve(result);
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => terminal,
      limit: () => Promise.resolve(result),
    };
    return chain as never;
  }) as never);
}

describe('callerCanViewUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true for the caller resolving themselves (no DB access)', async () => {
    queueSelectResults([]);
    expect(await callerCanViewUser('u1', 'u1')).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns true when an accepted connection exists', async () => {
    queueSelectResults([[{ status: 'ACCEPTED' }]]);
    expect(await callerCanViewUser('u1', 'u2')).toBe(true);
  });

  it('returns true when both share drive membership', async () => {
    queueSelectResults([
      [], // no connection
      [{ id: 'drive_a' }], // caller owns drive_a
      [], // caller member of none
      [{ driveId: 'drive_a' }], // target is a member of drive_a
    ]);
    expect(await callerCanViewUser('u1', 'u2')).toBe(true);
  });

  it('returns true when the target owns a drive the caller belongs to', async () => {
    queueSelectResults([
      [], // no connection
      [], // caller owns none
      [{ driveId: 'drive_b' }], // caller is a member of drive_b
      [], // target is a member of nothing shared
      [{ id: 'drive_b' }], // target owns drive_b
    ]);
    expect(await callerCanViewUser('u1', 'u2')).toBe(true);
  });

  it('returns false when there is no connection and no shared drive', async () => {
    queueSelectResults([
      [], // no connection
      [{ id: 'drive_a' }], // caller owns drive_a
      [], // caller member of none
      [], // target not a member of caller's drives
      [], // target owns none of caller's drives
    ]);
    expect(await callerCanViewUser('u1', 'u2')).toBe(false);
  });

  it('returns false (short-circuits drive checks) when the caller has no drives', async () => {
    queueSelectResults([
      [], // no connection
      [], // owns none
      [], // member of none
    ]);
    expect(await callerCanViewUser('u1', 'u2')).toBe(false);
    // 1 connection select + 2 drive-id selects; the shared-drive checks are skipped.
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it('gates driveMembers reads on isNotNull(acceptedAt) so pending invitations do not grant visibility (P1)', async () => {
    queueSelectResults([
      [], // no connection
      [{ id: 'drive_a' }], // caller owns drive_a
      [], // caller member of none (accepted)
      [], // target not an accepted member of caller's drives
      [], // target owns none of caller's drives
    ]);
    await callerCanViewUser('u1', 'u2');
    // Both the caller's member-drive lookup and the target shared-membership
    // lookup must compose the acceptedAt gate.
    expect(isNotNull).toHaveBeenCalledWith('driveMembers.acceptedAt');
  });
});

// ============================================================================
// searchRelatedProfilesByName — name-matches private-or-public profiles the
// caller already shares context with, used by /api/users/search so a private
// friend/collaborator is findable by name. The relationship is expressed as
// correlated EXISTS subqueries, so db.select() is issued in this order:
//   1. caller's owned drives          (getUserDriveIds)
//   2. caller's member drives         (getUserDriveIds)
//   3. connectedToCaller EXISTS subquery (always built)
//   4. co-member EXISTS subquery      (only when the caller has drives)
//   5. owner EXISTS subquery          (only when the caller has drives)
//   6. the main userProfiles query    (its result is what's returned)
// ============================================================================
describe('searchRelatedProfilesByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PATTERN = '%bob%';
  const friend = { userId: 'friend', username: 'bobby', displayName: 'Bob', bio: null, avatarUrl: null };

  it('returns the profiles matched by the bounded relationship query', async () => {
    queueSelectResults([
      [{ id: 'drive_a' }], // owned
      [], // member
      [], // connectedToCaller EXISTS subquery
      [], // co-member EXISTS subquery
      [], // owner EXISTS subquery
      [friend], // main query
    ]);
    const rows = await searchRelatedProfilesByName('u1', PATTERN, 10);
    expect(rows).toEqual([friend]);
  });

  it('composes the relationship, name, and safety gates', async () => {
    queueSelectResults([[{ id: 'drive_a' }], [], [], [], [], []]);
    await searchRelatedProfilesByName('u1', PATTERN, 10);
    // Accepted connections only; drive co-membership gated on acceptedAt.
    expect(eq).toHaveBeenCalledWith('connections.status', 'ACCEPTED');
    expect(isNotNull).toHaveBeenCalledWith('driveMembers.acceptedAt');
    // Temp/magic-link accounts excluded; caller never matches themselves.
    expect(isNotNull).toHaveBeenCalledWith('users.emailVerified');
    expect(ne).toHaveBeenCalledWith('userProfiles.userId', 'u1');
    // Name predicate applied on both username and display name.
    expect(ilike).toHaveBeenCalledWith('userProfiles.username', PATTERN);
    expect(ilike).toHaveBeenCalledWith('userProfiles.displayName', PATTERN);
    // connection + co-member + owner relationship subqueries.
    expect(exists).toHaveBeenCalledTimes(3);
  });

  it('uses only the connection relationship when the caller has no drives', async () => {
    queueSelectResults([
      [], // owned — none
      [], // member — none
      [], // connectedToCaller EXISTS subquery
      [friend], // main query
    ]);
    const rows = await searchRelatedProfilesByName('u1', PATTERN, 10);
    expect(rows).toEqual([friend]);
    // No drive-based EXISTS subqueries are built.
    expect(exists).toHaveBeenCalledTimes(1);
    // owned + member + connection subquery + main.
    expect(db.select).toHaveBeenCalledTimes(4);
  });
});
