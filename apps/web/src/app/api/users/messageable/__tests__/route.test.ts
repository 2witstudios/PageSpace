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
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ne: vi.fn(),
  isNotNull: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {},
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

function fromWhere(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as ReturnType<typeof db.select>;
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
    mockAuth();
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
      .mockReturnValueOnce(fromWhere([])) // connections (none)
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
        fromWhere([{ user1Id: userId, user2Id: 'user_alice' }])
      ) // connections include alice
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
      .mockReturnValueOnce(fromWhere([])) // connections
      .mockReturnValueOnce(fromLeftJoinWhere([userRow('user_alice', 'Alice')]));

    const response = await GET(new Request('http://localhost/api/users/messageable'));

    const body = await response.json();
    expect(body.users[0].sharedDriveCount).toBe(2);
  });
});
