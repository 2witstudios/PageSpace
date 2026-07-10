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

vi.mock('@/lib/auth/auth', () => ({
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

// Wrap (not replace) the real decryptUsersByIdOnce so call counts can be
// asserted at the route's call boundary — proves the route batches decryption
// once per request. A bare `vi.spyOn` doesn't work here because
// `@pagespace/lib` resolves to its built CJS dist output, and the
// per-row-dedup internals (decryptUserRow -> decryptField) are a *nested*
// require inside that compiled module, invisible to any mock at this level.
vi.mock('@pagespace/lib/auth/user-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/auth/user-repository')>();
  return { ...actual, decryptUsersByIdOnce: vi.fn(actual.decryptUsersByIdOnce) };
});

import { GET } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { db } from '@pagespace/db/db';
import { decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';
import { verifyAuth } from '@/lib/auth/auth';

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
    setupSelect([]);
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
    setupSelect([[targetRow], []]);
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
    // Searching your own email: the dual lookup resolves to the caller's own
    // row (same id), so isSelf collapses the response.
    setupSelect([[{ ...targetRow, id: mockUserId, email: currentEmail }], []]);
    const response = await GET(new Request(`http://localhost/api/connections/search?email=${currentEmail}`));
    const body = await response.json();
    expect(body).toEqual({ user: null });
    expect(body).not.toHaveProperty('error');
  });

  it('collapses a case-variant self-search into { user: null } (no self-profile enumeration)', async () => {
    // The blind index normalizes case, so "CURRENT@TEST.COM" resolves to the
    // caller's own row. db is chain-mocked here, so this proves the id-based
    // isSelf decision, not the blind-index SQL itself: a target row carrying
    // the caller's id must collapse regardless of the searched string's case.
    setupSelect([[{ ...targetRow, id: mockUserId, email: currentEmail }], []]);
    const response = await GET(new Request('http://localhost/api/connections/search?email=CURRENT@TEST.COM'));
    const body = await response.json();
    expect(body).toEqual({ user: null });
    expect(body).not.toHaveProperty('error');
  });

  it('collapses "no account" into a generic { user: null } with no error', async () => {
    setupSelect([[], []]);
    const response = await GET(new Request('http://localhost/api/connections/search?email=ghost@test.com'));
    const body = await response.json();
    expect(body).toEqual({ user: null });
    expect(body).not.toHaveProperty('error');
  });

  it('collapses every existing-relationship state into the SAME generic response', async () => {
    for (const status of ['PENDING', 'ACCEPTED', 'BLOCKED'] as const) {
      setupSelect([[targetRow], [{ status }]]);
      const response = await GET(new Request('http://localhost/api/connections/search?email=other@test.com'));
      const body = await response.json();
      expect(body, `status=${status}`).toEqual({ user: null });
      expect(body).not.toHaveProperty('error');
    }
  });

  it('decrypts the target in one batched call per request', async () => {
    const encryptedTargetName = await encryptField('Target');
    const encryptedTargetEmail = await encryptField('other@test.com');
    setupSelect([
      [{ ...targetRow, name: encryptedTargetName, email: encryptedTargetEmail, displayName: null }],
      [],
    ]);

    const response = await GET(new Request('http://localhost/api/connections/search?email=other@test.com'));
    const body = await response.json();

    expect(response.status).toBe(200);
    // Name/email decrypted at the edge; displayName falls back to the
    // decrypted name exactly as before the dedup change.
    expect(body).toEqual({
      user: {
        id: 'user_target',
        name: 'Target',
        email: 'other@test.com',
        displayName: 'Target',
        bio: 'bio',
        avatarUrl: 'https://cdn/a.png',
      },
    });
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
  });

  it('self-search with ciphertext email still collapses to { user: null } with one decrypt call', async () => {
    const encryptedCurrentEmail = await encryptField(currentEmail);
    setupSelect([
      [{ ...targetRow, id: mockUserId, email: encryptedCurrentEmail }],
      [],
    ]);

    const response = await GET(new Request(`http://localhost/api/connections/search?email=${currentEmail}`));
    const body = await response.json();

    // isSelf is decided by id (no caller-email decrypt at all); the target's
    // PII decrypts in the single batched call.
    expect(body).toEqual({ user: null });
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
  });
});
