/**
 * Security audit tests for /api/activities
 * Verifies auditRequest is called for GET (read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
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

import { GET } from '../route';
import { authenticateRequestWithOptions, getAllowedDriveIds } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { encryptField } from '@pagespace/lib/encryption/field-crypto';

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
});
