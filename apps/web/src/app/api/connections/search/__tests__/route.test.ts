/**
 * Tests for /api/connections/search (security audit finding L2).
 *
 * Verifies the endpoint returns a single generic `{ user: null }` for every
 * non-actionable outcome (self-search, no account, or an existing
 * PENDING/ACCEPTED/BLOCKED relationship) so existence and relationship state
 * cannot be enumerated — and only surfaces a profile when a connection request
 * can actually be sent. Also covers per-user rate limiting and the read audit.
 *
 * Mocked at the DB seam: each db.select() consumes the next queued result set,
 * in route order: (1) current-user email, (2) target user, (3) existing
 * connection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: { API: { maxAttempts: 100, windowMs: 60000 } },
}));

vi.mock('@pagespace/db/db', () => ({ db: { select: vi.fn() } }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', email: 'email', name: 'name' },
}));
vi.mock('@pagespace/db/schema/members', () => ({ userProfiles: {} }));
vi.mock('@pagespace/db/schema/social', () => ({ connections: {} }));

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

import { GET } from '../route';
import { verifyAuth } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { db } from '@pagespace/db/db';

const mockUserId = 'user_123';
const currentEmail = 'current@test.com';

function setupSelect(results: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation((() => {
    const result = results[i++] ?? [];
    const terminal = Promise.resolve(result) as Promise<unknown[]> & {
      limit: () => Promise<unknown[]>;
    };
    terminal.limit = () => Promise.resolve(result);
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => terminal,
      limit: () => Promise.resolve(result),
    };
    return chain as never;
  }) as never);
}

const targetRow = {
  id: 'user_target',
  name: 'Target',
  email: 'other@test.com',
  displayName: 'Target Display',
  bio: 'bio',
  avatarUrl: 'https://cdn/a.png',
};

describe('GET /api/connections/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue(
      { id: mockUserId, email: currentEmail } as unknown as Awaited<ReturnType<typeof verifyAuth>>,
    );
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
    setupSelect([[{ email: currentEmail }]]);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(verifyAuth).mockResolvedValue(null);
    const response = await GET(new Request('http://localhost/api/connections/search?email=x@test.com'));
    expect(response.status).toBe(401);
  });

  it('returns 429 when the per-user rate limit is exceeded', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: false, retryAfter: 12 });
    const response = await GET(new Request('http://localhost/api/connections/search?email=other@test.com'));
    const body = await response.json();
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(body.error).toBe('Too many requests');
  });

  it('logs a read audit event on connection search', async () => {
    await GET(new Request('http://localhost/api/connections/search?email=other@test.com'));
    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'data.read',
        userId: mockUserId,
        resourceType: 'connection_search',
        resourceId: 'self',
      }),
    );
  });

  it('returns the actionable user when one can be invited (exists, not self, no connection)', async () => {
    setupSelect([[{ email: currentEmail }], [targetRow], []]);
    const response = await GET(new Request('http://localhost/api/connections/search?email=other@test.com'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      user: {
        id: 'user_target',
        name: 'Target',
        email: 'other@test.com',
        displayName: 'Target Display',
        bio: 'bio',
        avatarUrl: 'https://cdn/a.png',
      },
    });
  });

  it('collapses self-search into a generic { user: null } with no error', async () => {
    // email === current user's email
    setupSelect([[{ email: currentEmail }], [{ ...targetRow, email: currentEmail }], []]);
    const response = await GET(new Request(`http://localhost/api/connections/search?email=${currentEmail}`));
    const body = await response.json();
    expect(body).toEqual({ user: null });
    expect(body).not.toHaveProperty('error');
  });

  it('collapses "no account" into a generic { user: null } with no error', async () => {
    setupSelect([[{ email: currentEmail }], [], []]);
    const response = await GET(new Request('http://localhost/api/connections/search?email=ghost@test.com'));
    const body = await response.json();
    expect(body).toEqual({ user: null });
    expect(body).not.toHaveProperty('error');
  });

  it('collapses every existing-relationship state into the SAME generic response', async () => {
    for (const status of ['PENDING', 'ACCEPTED', 'BLOCKED'] as const) {
      setupSelect([[{ email: currentEmail }], [targetRow], [{ status }]]);
      const response = await GET(new Request('http://localhost/api/connections/search?email=other@test.com'));
      const body = await response.json();
      expect(body, `status=${status}`).toEqual({ user: null });
      expect(body).not.toHaveProperty('error');
    }
  });
});
