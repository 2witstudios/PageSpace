/**
 * Security audit tests for /api/activities
 * Verifies auditRequest is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  getAllowedDriveIds: vi.fn().mockReturnValue(null),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 0 }]),
      }),
    }),
    query: {
      activityLogs: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserViewPage: vi.fn().mockResolvedValue(true),
    isUserDriveMember: vi.fn().mockResolvedValue(true),
}));

// Wrap (not replace) the real decryptUsersByIdOnce so call counts can be
// asserted at the route's call boundary — proves the route batches decryption
// once per request instead of once per row (the actual regression this test
// guards). A bare `vi.spyOn` doesn't work here because `@pagespace/lib`
// resolves to its built CJS dist output, and the per-row-dedup internals
// (decryptUserRow -> decryptField) are a *nested* require inside that
// compiled module, invisible to any mock declared at this level.
vi.mock('@pagespace/lib/auth/user-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/auth/user-repository')>();
  return { ...actual, decryptUsersByIdOnce: vi.fn(actual.decryptUsersByIdOnce) };
});

import { GET } from '../route';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';
import { decryptUsersByIdOnce } from '@pagespace/lib/auth/user-repository';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { getAllowedDriveIds } from '@/lib/auth/auth-core';

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

describe('GET /api/activities audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs read audit event on successful activities retrieval', async () => {
    await GET(new Request('http://localhost/api/activities?context=user'));

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ eventType: 'data.read', userId: mockUserId, resourceType: 'activities', resourceId: 'self' })
    );
  });
});

describe('GET /api/activities PII decryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
  });

  it('decrypts ciphertext user name/email before responding', async () => {
    const encryptedName = await encryptField('Real Name');
    const encryptedEmail = await encryptField('real@example.com');
    vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([
      {
        id: 'act-1',
        user: { id: 'user-1', name: encryptedName, email: encryptedEmail, image: null },
      },
    ] as never);

    const res = await GET(new Request('http://localhost/api/activities?context=user'));
    const body = await res.json();

    expect(body.activities[0].user.name).toBe('Real Name');
    expect(body.activities[0].user.email).toBe('real@example.com');
  });

  it('passes through legacy plaintext user name/email unchanged', async () => {
    vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([
      {
        id: 'act-1',
        user: { id: 'user-1', name: 'Legacy Name', email: 'legacy@example.com', image: null },
      },
    ] as never);

    const res = await GET(new Request('http://localhost/api/activities?context=user'));
    const body = await res.json();

    expect(body.activities[0].user.name).toBe('Legacy Name');
    expect(body.activities[0].user.email).toBe('legacy@example.com');
  });

  it('does not crash when the activity has no joined user (deleted user)', async () => {
    vi.mocked(db.query.activityLogs.findMany).mockResolvedValue([
      { id: 'act-1', user: null, actorDisplayName: 'Deleted User', actorEmail: 'deleted@example.com' },
    ] as never);

    const res = await GET(new Request('http://localhost/api/activities?context=user'));
    const body = await res.json();

    expect(body.activities[0].user).toBeNull();
    expect(body.activities[0].actorDisplayName).toBe('Deleted User');
  });

  it('decrypts one actor shared across many activity rows only once (dedup)', async () => {
    const encryptedName = await encryptField('Real Name');
    const encryptedEmail = await encryptField('real@example.com');
    const sharedUser = { id: 'user-1', name: encryptedName, email: encryptedEmail, image: null };
    const activities = Array.from({ length: 50 }, (_, i) => ({ id: `act-${i}`, user: sharedUser }));
    vi.mocked(db.query.activityLogs.findMany).mockResolvedValue(activities as never);

    const res = await GET(new Request('http://localhost/api/activities?context=user'));
    const body = await res.json();

    expect(body.activities).toHaveLength(50);
    expect(body.activities[0].user.name).toBe('Real Name');
    expect(body.activities[49].user.email).toBe('real@example.com');
    // Decryption is batched once per request (dedup happens inside), not
    // once per of the 50 activity rows.
    expect(vi.mocked(decryptUsersByIdOnce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decryptUsersByIdOnce).mock.calls[0][0]).toHaveLength(50);
  });
});
