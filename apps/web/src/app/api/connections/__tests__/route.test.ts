/**
 * Security audit tests for /api/connections
 * Verifies auditRequest is called for GET (read) and POST (write).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: {},
}));
vi.mock('@pagespace/db/schema/members', () => ({
  userProfiles: {},
}));
vi.mock('@pagespace/db/schema/social', () => ({
  connections: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/notifications/notifications', () => ({
  createNotification: vi.fn(),
}));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  isEmailVerified: vi.fn().mockResolvedValue(true),
}));

// Wrap (not replace) the real decryptUsersByIdOnce so call counts can be
// asserted at the route's call boundary — proves the route batches decryption
// once per request instead of once per row. A bare `vi.spyOn` doesn't work
// here because `@pagespace/lib` resolves to its built CJS dist output, and the
// per-row-dedup internals (decryptUserRow -> decryptField) are a *nested*
// require inside that compiled module, invisible to any mock at this level.
vi.mock('@pagespace/lib/auth/user-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/auth/user-repository')>();
  return { ...actual, decryptUsersByIdOnce: vi.fn(actual.decryptUsersByIdOnce) };
});

import { GET, POST } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const mockUserId = 'user_123';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

describe('GET /api/connections audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs read audit event on successful connections retrieval', async () => {
    await GET(new Request('http://localhost/api/connections'));

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'connections', resourceId: 'self' })
    );
  });
});

describe('GET /api/connections PII decryption dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  // Queue results in route order: (1) connections list (…orderBy), then
  // (2) connected-user details (…leftJoin…where).
  const setupSelect = (connectionRows: unknown[], userRows: unknown[]) => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(connectionRows),
          }),
        }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(userRows),
          }),
        }),
      } as never);
  };

  const connectionRow = (id: string, otherUserId: string) => ({
    id,
    status: 'ACCEPTED',
    requestedAt: '2026-05-01T00:00:00.000Z',
    acceptedAt: '2026-05-02T00:00:00.000Z',
    requestMessage: null,
    user1Id: mockUserId,
    user2Id: otherUserId,
    requestedBy: mockUserId,
  });

  it('decrypts every connected user in one batched call per request (dedup)', async () => {
    const encryptedNameA = await encryptField('User A');
    const encryptedEmailA = await encryptField('a@example.com');
    setupSelect(
      [connectionRow('conn_1', 'user_a'), connectionRow('conn_2', 'user_b')],
      [
        { id: 'user_a', name: encryptedNameA, email: encryptedEmailA, image: null, username: 'a', displayName: null, bio: null, avatarUrl: null },
        { id: 'user_b', name: 'Plain B', email: 'b@example.com', image: null, username: 'b', displayName: null, bio: null, avatarUrl: null },
      ]
    );

    const res = await GET(new Request('http://localhost/api/connections'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connections).toHaveLength(2);
    const byId = new Map(body.connections.map((c: { user: { id: string } }) => [c.user.id, c]));
    expect((byId.get('user_a') as { user: { name: string; email: string } }).user.name).toBe('User A');
    expect((byId.get('user_a') as { user: { name: string; email: string } }).user.email).toBe('a@example.com');
    // Legacy plaintext passes through unchanged.
    expect((byId.get('user_b') as { user: { name: string; email: string } }).user.name).toBe('Plain B');
    // Decryption is batched once per request (dedup happens inside), not
    // once per connected-user row.
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decryptUsersByIdOnce).mock.calls[0][0]).toHaveLength(2);
  });
});

describe('POST /api/connections audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs write audit event on connection request', async () => {
    const request = new Request('http://localhost/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user_456' }),
    });

    await POST(request);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.write', userId: mockUserId, resourceType: 'connection', resourceId: 'self' })
    );
  });
});
