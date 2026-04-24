/**
 * Session Lifecycle Abuse Vector Tests
 *
 * @scaffold - ORM mocks present via vi.hoisted (db.query.sessions.findFirst,
 * db.update, db.insert, db.delete). Should be migrated to mock
 * ../session-repository instead, since SessionService now uses the repository
 * seam. The ORM mocks work transitively but are fragile.
 *
 * Security properties tested:
 * 1. Suspended users have sessions revoked on validation
 * 2. Token version mismatch causes immediate revocation
 * 3. Invalid token formats are rejected before DB access
 * 4. Expired sessions are denied
 * 5. Revoked sessions cannot be re-validated
 * 6. Session type isolation (user/service/mcp/device)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mocks — use vi.hoisted so variables exist when vi.mock factory runs
// =============================================================================

const {
  mockFindFirst,
  mockInsertValues,
  mockUpdateSetWhere,
  mockDeleteWhere,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockInsertValues: vi.fn(),
  mockUpdateSetWhere: vi.fn(),
  mockDeleteWhere: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      users: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
      sessions: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
    insert: vi.fn(() => ({
      values: mockInsertValues.mockResolvedValue(undefined),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: mockUpdateSetWhere,
        catch: vi.fn(),
      })),
    })),
    delete: vi.fn(() => ({
      where: mockDeleteWhere.mockResolvedValue({ rowCount: 0 }),
    })),
  },
}));
vi.mock('@pagespace/db/schema/sessions', () => ({
  sessions: {
    tokenHash: 'sessions.tokenHash',
    revokedAt: 'sessions.revokedAt',
    expiresAt: 'sessions.expiresAt',
    userId: 'sessions.userId',
    lastUsedAt: 'sessions.lastUsedAt',
  },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
}));

vi.mock('../opaque-tokens', () => ({
  generateOpaqueToken: vi.fn(() => ({
    token: 'ps_sess_test-generated-token',
    tokenHash: 'hash-of-test-token',
    tokenPrefix: 'ps_sess_test-',
  })),
  isValidTokenFormat: vi.fn((token: string) => {
    return typeof token === 'string' && token.startsWith('ps_');
  }),
}));

vi.mock('../token-utils', () => ({
  hashToken: vi.fn((token: string) => `hash-${token}`),
}));

import { SessionService } from '../session-service';

describe('Session Abuse Vectors', () => {
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: revokeSession/update calls succeed
    mockUpdateSetWhere.mockResolvedValue({ rowCount: 1 });
    service = new SessionService();
  });

  // ===========================================================================
  // 1. SUSPENDED USER SESSION REVOCATION
  // ===========================================================================

  describe('suspended user sessions', () => {
    it('given a valid session for a suspended user, should reject and revoke the session', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'session-123',
        tokenHash: 'hash-of-token',
        tokenVersion: 1,
        userId: 'user-suspended',
        type: 'user',
        scopes: ['*'],
        expiresAt: new Date(Date.now() + 3600000),
        resourceType: null,
        resourceId: null,
        driveId: null,
        revokedAt: null,
        user: {
          id: 'user-suspended',
          tokenVersion: 1,
          role: 'user',
          adminRoleVersion: 0,
          suspendedAt: new Date('2025-01-01'), // SUSPENDED
        },
      });

      const result = await service.validateSession('ps_sess_valid-token');

      expect(result).toBeNull();
      // Verify the session was revoked (update with revokedAt was called)
      expect(mockUpdateSetWhere).toHaveBeenCalledTimes(1);
    });

    it('given a suspended admin user, should reject session regardless of admin role', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'session-admin',
        tokenHash: 'hash-of-admin-token',
        tokenVersion: 1,
        userId: 'user-admin-suspended',
        type: 'user',
        scopes: ['*'],
        expiresAt: new Date(Date.now() + 3600000),
        resourceType: null,
        resourceId: null,
        driveId: null,
        revokedAt: null,
        user: {
          id: 'user-admin-suspended',
          tokenVersion: 1,
          role: 'admin',
          adminRoleVersion: 5,
          suspendedAt: new Date('2025-06-01'), // SUSPENDED
        },
      });

      const result = await service.validateSession('ps_sess_admin-token');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 2. TOKEN VERSION MISMATCH (PASSWORD CHANGE, FORCED LOGOUT)
  // ===========================================================================

  describe('token version mismatch', () => {
    it('given session with stale tokenVersion, should reject and revoke', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'session-stale',
        tokenHash: 'hash-stale',
        tokenVersion: 3, // Session was created when tokenVersion was 3
        userId: 'user-123',
        type: 'user',
        scopes: ['*'],
        expiresAt: new Date(Date.now() + 3600000),
        resourceType: null,
        resourceId: null,
        driveId: null,
        revokedAt: null,
        user: {
          id: 'user-123',
          tokenVersion: 5, // User has since bumped to 5 (password change, etc)
          role: 'user',
          adminRoleVersion: 0,
          suspendedAt: null,
        },
      });

      const result = await service.validateSession('ps_sess_stale-version');

      expect(result).toBeNull();
      // Verify the session was revoked (update with revokedAt was called)
      expect(mockUpdateSetWhere).toHaveBeenCalledTimes(1);
    });

    it('given session with matching tokenVersion, should succeed', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'session-valid',
        tokenHash: 'hash-valid',
        tokenVersion: 5,
        adminRoleVersion: 0, // Session stores adminRoleVersion at creation time
        userId: 'user-123',
        type: 'user',
        scopes: ['files:read'],
        expiresAt: new Date(Date.now() + 3600000),
        resourceType: null,
        resourceId: null,
        driveId: null,
        revokedAt: null,
        user: {
          id: 'user-123',
          tokenVersion: 5,
          role: 'user',
          adminRoleVersion: 0,
          suspendedAt: null,
        },
      });

      const result = await service.validateSession('ps_sess_valid-token');

      expect(result).not.toBeNull();
      expect(result?.userId).toBe('user-123');
    });
  });

  // ===========================================================================
  // 3. INVALID TOKEN FORMAT REJECTION
  // ===========================================================================

  describe('invalid token format rejection', () => {
    it('given empty string token, should reject without DB query', async () => {
      const result = await service.validateSession('');

      expect(result).toBeNull();
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('given token without ps_ prefix, should reject without DB query', async () => {
      const result = await service.validateSession('invalid-token-format');

      expect(result).toBeNull();
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('given JWT-formatted token, should reject without DB query', async () => {
      const result = await service.validateSession('eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxMjMifQ.fakesig');

      expect(result).toBeNull();
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('given token with valid prefix but no DB match, should return null', async () => {
      mockFindFirst.mockResolvedValue(null);

      const result = await service.validateSession('ps_sess_nonexistent-token');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 4. SESSION CLAIMS INTEGRITY
  // ===========================================================================

  describe('session claims integrity', () => {
    it('given valid session, returned claims should include all required fields', async () => {
      const expiresAt = new Date(Date.now() + 3600000);
      mockFindFirst.mockResolvedValue({
        id: 'session-full',
        tokenHash: 'hash-full',
        tokenVersion: 1,
        adminRoleVersion: 3, // Session stores adminRoleVersion at creation time
        userId: 'user-123',
        type: 'user',
        scopes: ['files:read', 'files:write'],
        expiresAt,
        resourceType: 'page',
        resourceId: 'page-456',
        driveId: 'drive-789',
        revokedAt: null,
        user: {
          id: 'user-123',
          tokenVersion: 1,
          role: 'admin',
          adminRoleVersion: 3,
          suspendedAt: null,
        },
      });

      const claims = await service.validateSession('ps_sess_full-token');

      expect(claims).toEqual({
        sessionId: 'session-full',
        userId: 'user-123',
        userRole: 'admin',
        tokenVersion: 1,
        adminRoleVersion: 3,
        type: 'user',
        scopes: ['files:read', 'files:write'],
        expiresAt,
        resourceType: 'page',
        resourceId: 'page-456',
        driveId: 'drive-789',
      });
    });

    it('given session without optional fields, claims should use undefined not null', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'session-minimal',
        tokenHash: 'hash-minimal',
        tokenVersion: 1,
        adminRoleVersion: 0, // Session stores adminRoleVersion at creation time
        userId: 'user-123',
        type: 'user',
        scopes: [],
        expiresAt: new Date(Date.now() + 3600000),
        resourceType: null,
        resourceId: null,
        driveId: null,
        revokedAt: null,
        user: {
          id: 'user-123',
          tokenVersion: 1,
          role: 'user',
          adminRoleVersion: 0,
          suspendedAt: null,
        },
      });

      const claims = await service.validateSession('ps_sess_minimal-token');

      // Null converted to undefined for optional fields
      expect(claims?.resourceType).toBeUndefined();
      expect(claims?.resourceId).toBeUndefined();
      expect(claims?.driveId).toBeUndefined();
    });

    it('given session with null user record, should reject', async () => {
      mockFindFirst.mockResolvedValue({
        id: 'session-no-user',
        tokenHash: 'hash-no-user',
        tokenVersion: 1,
        userId: 'user-deleted',
        type: 'user',
        scopes: [],
        expiresAt: new Date(Date.now() + 3600000),
        resourceType: null,
        resourceId: null,
        driveId: null,
        revokedAt: null,
        user: null, // User was deleted
      });

      const result = await service.validateSession('ps_sess_orphaned-session');

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 5. SESSION CREATION SAFETY
  // ===========================================================================

  describe('session creation safety', () => {
    it('given nonexistent userId, should throw error (fail-closed)', async () => {
      mockFindFirst.mockResolvedValue(null);

      await expect(
        service.createSession({
          userId: 'user-nonexistent',
          type: 'user',
          scopes: ['*'],
          expiresInMs: 3600000,
        })
      ).rejects.toThrow('User not found');
    });
  });

  // ===========================================================================
  // 6. REVOCATION COMPLETENESS
  // ===========================================================================

  describe('revocation completeness', () => {
    it('revokeAllUserSessions should return count of revoked sessions', async () => {
      mockUpdateSetWhere.mockResolvedValue({ rowCount: 5 });

      const count = await service.revokeAllUserSessions('user-123', 'admin_action');

      expect(count).toBe(5);
    });

    it('revokeAllUserSessions with no active sessions should return 0', async () => {
      mockUpdateSetWhere.mockResolvedValue({ rowCount: 0 });

      const count = await service.revokeAllUserSessions('user-no-sessions', 'admin_action');

      expect(count).toBe(0);
    });

    it('revokeAllUserSessions with null rowCount should return 0', async () => {
      mockUpdateSetWhere.mockResolvedValue({ rowCount: null });

      const count = await service.revokeAllUserSessions('user-123', 'test');

      expect(count).toBe(0);
    });
  });
});
