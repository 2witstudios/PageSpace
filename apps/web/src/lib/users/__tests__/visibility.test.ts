import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// callerCanViewUser — relationship scoping for /api/users/find (L1).
//
// Mocked at the DB seam for the connection check (the only db.select() this
// module still issues for it); drive co-membership is the permissions layer's
// sharesMemberDrive (org-aware, accepted rows only), mocked here.
// ============================================================================

// The one member-drive set (org-aware; owned drives plus accepted rows while dark).
vi.mock('@pagespace/lib/permissions/member-drives', () => ({
  getMemberDriveIds: vi.fn(async () => []),
  sharesMemberDrive: vi.fn(async () => false),
  memberOfAnyDriveCondition: vi.fn(() => ({ __memberOfAnyDrive: true })),
}));

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
import { getMemberDriveIds, memberOfAnyDriveCondition, sharesMemberDrive } from '@pagespace/lib/permissions/member-drives';

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
    expect(sharesMemberDrive).not.toHaveBeenCalled();
  });

  it('returns true when an accepted connection exists, without asking about drives', async () => {
    queueSelectResults([[{ status: 'ACCEPTED' }]]);
    expect(await callerCanViewUser('u1', 'u2')).toBe(true);
    expect(sharesMemberDrive).not.toHaveBeenCalled();
  });

  it('returns true when the two share a member drive (owned or joined)', async () => {
    queueSelectResults([[]]);
    vi.mocked(sharesMemberDrive).mockResolvedValueOnce(true);
    expect(await callerCanViewUser('u1', 'u2')).toBe(true);
    expect(sharesMemberDrive).toHaveBeenCalledWith('u1', 'u2');
  });

  it('returns false when there is no connection and no shared member drive', async () => {
    queueSelectResults([[]]);
    expect(await callerCanViewUser('u1', 'u2')).toBe(false);
  });

  it('DRV-5 (partial) X-6 (partial) co-membership is the permissions layer\'s answer (accepted rows, implicit Open members, stale org rows counting for nothing), never a drive_members read here', async () => {
    queueSelectResults([[]]);
    vi.mocked(sharesMemberDrive).mockResolvedValueOnce(false);
    expect(await callerCanViewUser('u1', 'u2')).toBe(false);
    // Only the connection check touched the database.
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// searchRelatedProfilesByName — name-matches private-or-public profiles the
// caller already shares context with, used by /api/users/search so a private
// friend/collaborator is findable by name. The relationship is expressed as
// correlated EXISTS subqueries plus the permissions layer's
// memberOfAnyDriveCondition, so db.select() is issued in this order:
//   1. connectedToCaller EXISTS subquery (always built)
//   2. the main userProfiles query    (its result is what's returned)
// ============================================================================
describe('searchRelatedProfilesByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PATTERN = '%bob%';
  const friend = { userId: 'friend', username: 'bobby', displayName: 'Bob', bio: null, avatarUrl: null };

  it('returns the profiles matched by the bounded relationship query', async () => {
    vi.mocked(getMemberDriveIds).mockResolvedValueOnce(['drive_a']);
    queueSelectResults([
      [], // connectedToCaller EXISTS subquery
      [friend], // main query
    ]);
    const rows = await searchRelatedProfilesByName('u1', PATTERN, 10);
    expect(rows).toEqual([friend]);
  });

  it('composes the relationship, name, and safety gates', async () => {
    vi.mocked(getMemberDriveIds).mockResolvedValueOnce(['drive_a']);
    queueSelectResults([[], []]);
    await searchRelatedProfilesByName('u1', PATTERN, 10);
    // Accepted connections only.
    expect(eq).toHaveBeenCalledWith('connections.status', 'ACCEPTED');
    // Co-membership of the caller's member drives, decided by the permissions layer.
    expect(getMemberDriveIds).toHaveBeenCalledWith('u1', { includeTrashed: true });
    expect(memberOfAnyDriveCondition).toHaveBeenCalledWith('userProfiles.userId', ['drive_a']);
    // Temp/magic-link accounts excluded; caller never matches themselves.
    expect(isNotNull).toHaveBeenCalledWith('users.emailVerified');
    expect(ne).toHaveBeenCalledWith('userProfiles.userId', 'u1');
    // Name predicate applied on both username and display name.
    expect(ilike).toHaveBeenCalledWith('userProfiles.username', PATTERN);
    expect(ilike).toHaveBeenCalledWith('userProfiles.displayName', PATTERN);
    // Only the connection subquery is built here.
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('uses only the connection relationship when the caller has no member drives', async () => {
    queueSelectResults([
      [], // connectedToCaller EXISTS subquery
      [friend], // main query
    ]);
    const rows = await searchRelatedProfilesByName('u1', PATTERN, 10);
    expect(rows).toEqual([friend]);
    expect(memberOfAnyDriveCondition).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
