/**
 * Tests for GET /api/users/messageable.
 * Returns the union of accepted connections and drive co-members,
 * deduplicated. When a user appears in both, source = 'connection'.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
// Operators build an inspectable predicate tree so a test can see which
// filters each query carries.
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {
    driveId: 'driveMembers.driveId',
    userId: 'driveMembers.userId',
    acceptedAt: 'driveMembers.acceptedAt',
  },
  userProfiles: {},
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: {},
}));
vi.mock('@pagespace/db/schema/social', () => ({
  connections: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { driveMembers } from '@pagespace/db/schema/members';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const userId = 'user_self';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

/** Every `.from(table).where(predicate)` the route issued, in order. */
let queries: Array<{ table: unknown; predicate: unknown }> = [];

function fromWhere(rows: unknown[]) {
  return {
    from: vi.fn((table: unknown) => ({
      where: vi.fn((predicate: unknown) => {
        queries.push({ table, predicate });
        return Promise.resolve(rows);
      }),
    })),
  } as unknown as ReturnType<typeof db.select>;
}

function containsAcceptedGate(predicate: unknown): boolean {
  if (predicate === null || typeof predicate !== 'object') return false;
  if ('isNotNull' in predicate && predicate.isNotNull === driveMembers.acceptedAt) return true;
  return Object.values(predicate).some((v) =>
    Array.isArray(v) ? v.some(containsAcceptedGate) : containsAcceptedGate(v)
  );
}

function fromLeftJoinWhere(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function userRow(id: string, displayName: string) {
  return {
    id,
    name: displayName,
    email: `${id}@example.com`,
    image: null,
    username: id,
    displayName,
    bio: null,
    avatarUrl: null,
  };
}

describe('GET /api/users/messageable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries = [];
    mockAuth();
  });

  // A pending, unaccepted invitation is not an established shared context
  // (apps/web/src/lib/users/visibility.ts): the invitee must not resolve other
  // members' identities (name, email, bio, avatar) from the DM picker, and
  // members must not resolve the invitee's. Both drive_members reads — the
  // caller's own drives and the co-members of those drives — must therefore
  // carry the acceptedAt gate.
  it('gates both drive_members reads on acceptedAt so a pending invitee resolves no roster', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(fromWhere([])) // owned drives
      .mockReturnValueOnce(fromWhere([{ driveId: 'drive_1' }])) // member drives
      .mockReturnValueOnce(fromWhere([])) // other owners
      .mockReturnValueOnce(fromWhere([])) // other members
      .mockReturnValueOnce(fromWhere([])); // relationships

    const response = await GET(new Request('http://localhost/api/users/messageable'));

    expect(response.status).toBe(200);
    const memberReads = queries.filter((q) => q.table === driveMembers);
    expect(memberReads).toHaveLength(2);
    for (const read of memberReads) {
      expect(containsAcceptedGate(read.predicate)).toBe(true);
    }
  });

  it('returns empty users array when user has no drives or connections', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(fromWhere([])) // owned drives
      .mockReturnValueOnce(fromWhere([])) // member drives
      .mockReturnValueOnce(fromWhere([])); // connections

    const response = await GET(new Request('http://localhost/api/users/messageable'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.users).toEqual([]);
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', resourceType: 'messageable_users' })
    );
  });

  it('returns drive co-members with source=drive and a sharedDriveCount', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(fromWhere([{ id: 'drive_1' }])) // owned drives
      .mockReturnValueOnce(fromWhere([])) // member drives
      .mockReturnValueOnce(fromWhere([])) // other owners on those drives
      .mockReturnValueOnce(
        fromWhere([
          { userId: 'user_alice', driveId: 'drive_1' },
          { userId: 'user_bob', driveId: 'drive_1' },
        ])
      ) // other accepted members
      .mockReturnValueOnce(fromWhere([])) // relationships (no connections, no blocks)
      .mockReturnValueOnce(
        fromLeftJoinWhere([userRow('user_alice', 'Alice'), userRow('user_bob', 'Bob')])
      );

    const response = await GET(new Request('http://localhost/api/users/messageable'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.users).toHaveLength(2);
    const alice = body.users.find((u: { id: string }) => u.id === 'user_alice');
    expect(alice).toMatchObject({
      source: 'drive',
      sharedDriveCount: 1,
      displayName: 'Alice',
    });
  });

  it('prefers source=connection when user is both a connection and a drive co-member', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(fromWhere([{ id: 'drive_1' }])) // owned drives
      .mockReturnValueOnce(fromWhere([])) // member drives
      .mockReturnValueOnce(fromWhere([])) // other owners
      .mockReturnValueOnce(fromWhere([{ userId: 'user_alice', driveId: 'drive_1' }])) // co-member
      .mockReturnValueOnce(
        fromWhere([{ user1Id: userId, user2Id: 'user_alice', status: 'ACCEPTED' }])
      ) // accepted connection with alice
      .mockReturnValueOnce(fromLeftJoinWhere([userRow('user_alice', 'Alice')]));

    const response = await GET(new Request('http://localhost/api/users/messageable'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      id: 'user_alice',
      source: 'connection',
      sharedDriveCount: 1,
    });
  });

  it('excludes BLOCKED relationships even when the users share a drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(fromWhere([{ id: 'drive_1' }])) // owned drives
      .mockReturnValueOnce(fromWhere([])) // member drives
      .mockReturnValueOnce(fromWhere([])) // other owners
      .mockReturnValueOnce(
        fromWhere([
          { userId: 'user_alice', driveId: 'drive_1' },
          { userId: 'user_bob', driveId: 'drive_1' },
        ])
      ) // alice and bob co-members
      .mockReturnValueOnce(
        fromWhere([{ user1Id: userId, user2Id: 'user_alice', status: 'BLOCKED' }])
      ) // alice is blocked
      .mockReturnValueOnce(fromLeftJoinWhere([userRow('user_bob', 'Bob')]));

    const response = await GET(new Request('http://localhost/api/users/messageable'));

    const body = await response.json();
    const ids = body.users.map((u: { id: string }) => u.id);
    expect(ids).toEqual(['user_bob']);
    expect(ids).not.toContain('user_alice');
  });

  it('counts membership across multiple shared drives correctly', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(fromWhere([{ id: 'drive_1' }, { id: 'drive_2' }])) // owns 2 drives
      .mockReturnValueOnce(fromWhere([])) // no member drives
      .mockReturnValueOnce(fromWhere([])) // other owners
      .mockReturnValueOnce(
        fromWhere([
          { userId: 'user_alice', driveId: 'drive_1' },
          { userId: 'user_alice', driveId: 'drive_2' },
        ])
      ) // alice is member of both
      .mockReturnValueOnce(fromWhere([])) // relationships (none)
      .mockReturnValueOnce(fromLeftJoinWhere([userRow('user_alice', 'Alice')]));

    const response = await GET(new Request('http://localhost/api/users/messageable'));

    const body = await response.json();
    expect(body.users[0].sharedDriveCount).toBe(2);
  });
});
