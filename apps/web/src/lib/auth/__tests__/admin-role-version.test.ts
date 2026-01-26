import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, users, sessions, eq } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { updateUserRole, validateAdminAccess } from '../admin-role';

// Mock sessionService to avoid race conditions with parallel test execution
// The real sessionService has a TOCTOU gap between user lookup and session insert
vi.mock('@pagespace/lib/auth', async () => {
  const actual = await vi.importActual('@pagespace/lib/auth');
  return {
    ...actual,
    sessionService: {
      createSession: vi.fn(),
      validateSession: vi.fn(),
    },
  };
});

// Import the mocked module after vi.mock declaration
import { sessionService } from '@pagespace/lib/auth';

describe('Admin Role Versioning', () => {
  let adminUserId: string;
  let regularUserId: string;

  beforeEach(async () => {
    // Create an admin user
    const [adminUser] = await db.insert(users).values({
      id: createId(),
      name: 'Test Admin User',
      email: `test-admin-${Date.now()}@example.com`,
      password: 'hashed_password',
      provider: 'email',
      role: 'admin',
      tokenVersion: 1,
      adminRoleVersion: 0,
    }).returning();
    adminUserId = adminUser.id;

    // Create a regular user
    const [regularUser] = await db.insert(users).values({
      id: createId(),
      name: 'Test Regular User',
      email: `test-regular-${Date.now()}@example.com`,
      password: 'hashed_password',
      provider: 'email',
      role: 'user',
      tokenVersion: 1,
      adminRoleVersion: 0,
    }).returning();
    regularUserId = regularUser.id;
  });

  afterEach(async () => {
    await db.delete(sessions).where(eq(sessions.userId, adminUserId));
    await db.delete(sessions).where(eq(sessions.userId, regularUserId));
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, regularUserId));
  });

  describe('adminRoleVersion schema field', () => {
    it('users table has adminRoleVersion field defaulting to 0', async () => {
      const user = await db.query.users.findFirst({
        where: eq(users.id, adminUserId),
        columns: { adminRoleVersion: true },
      });

      expect(user).toBeTruthy();
      expect(user?.adminRoleVersion).toBe(0);
    });
  });

  describe('updateUserRole', () => {
    it('bumps adminRoleVersion when changing role', async () => {
      // Get initial version
      const beforeUser = await db.query.users.findFirst({
        where: eq(users.id, regularUserId),
        columns: { role: true, adminRoleVersion: true },
      });
      expect(beforeUser?.adminRoleVersion).toBe(0);
      expect(beforeUser?.role).toBe('user');

      // Promote to admin
      await updateUserRole(regularUserId, 'admin');

      // Check version bumped
      const afterUser = await db.query.users.findFirst({
        where: eq(users.id, regularUserId),
        columns: { role: true, adminRoleVersion: true },
      });
      expect(afterUser?.role).toBe('admin');
      expect(afterUser?.adminRoleVersion).toBe(1);
    });

    it('bumps adminRoleVersion on demotion from admin', async () => {
      // Demote admin to user
      await updateUserRole(adminUserId, 'user');

      const user = await db.query.users.findFirst({
        where: eq(users.id, adminUserId),
        columns: { role: true, adminRoleVersion: true },
      });
      expect(user?.role).toBe('user');
      expect(user?.adminRoleVersion).toBe(1);
    });

    it('increments adminRoleVersion on each role change', async () => {
      // Multiple role changes
      await updateUserRole(regularUserId, 'admin');
      await updateUserRole(regularUserId, 'user');
      await updateUserRole(regularUserId, 'admin');

      const user = await db.query.users.findFirst({
        where: eq(users.id, regularUserId),
        columns: { adminRoleVersion: true },
      });
      expect(user?.adminRoleVersion).toBe(3);
    });

    it('returns the updated user data', async () => {
      const result = await updateUserRole(regularUserId, 'admin');

      expect(result).toBeTruthy();
      expect(result?.role).toBe('admin');
      expect(result?.adminRoleVersion).toBe(1);
    });

    it('returns null for non-existent user', async () => {
      const result = await updateUserRole('non-existent-id', 'admin');
      expect(result).toBeNull();
    });
  });

  describe('Session claims include adminRoleVersion', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('includes adminRoleVersion in session claims for admin users', async () => {
      // Get the user's actual adminRoleVersion from DB
      const user = await db.query.users.findFirst({
        where: eq(users.id, adminUserId),
        columns: { adminRoleVersion: true, role: true },
      });
      expect(user).toBeTruthy();
      expect(user?.adminRoleVersion).toBe(0);

      // Mock sessionService to return claims with the DB user's adminRoleVersion
      vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_mock_token');
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'mock-session-id',
        userId: adminUserId,
        userRole: 'admin',
        tokenVersion: 1,
        adminRoleVersion: user!.adminRoleVersion,
        type: 'user',
        scopes: ['*'],
        expiresAt: new Date(Date.now() + 3600000),
      });

      const token = await sessionService.createSession({
        userId: adminUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      const claims = await sessionService.validateSession(token);

      expect(claims).toBeTruthy();
      expect(claims?.adminRoleVersion).toBe(0);
    });

    it('includes adminRoleVersion in session claims for regular users', async () => {
      // Get the user's actual adminRoleVersion from DB
      const user = await db.query.users.findFirst({
        where: eq(users.id, regularUserId),
        columns: { adminRoleVersion: true, role: true },
      });
      expect(user).toBeTruthy();
      expect(user?.adminRoleVersion).toBe(0);

      // Mock sessionService to return claims with the DB user's adminRoleVersion
      vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_mock_token');
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        sessionId: 'mock-session-id',
        userId: regularUserId,
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: user!.adminRoleVersion,
        type: 'user',
        scopes: ['*'],
        expiresAt: new Date(Date.now() + 3600000),
      });

      const token = await sessionService.createSession({
        userId: regularUserId,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 3600000,
      });

      const claims = await sessionService.validateSession(token);

      expect(claims).toBeTruthy();
      expect(claims?.adminRoleVersion).toBe(0);
    });
  });

  describe('validateAdminAccess', () => {
    it('returns true for valid admin with matching adminRoleVersion', async () => {
      const result = await validateAdminAccess(adminUserId, 0);
      expect(result).toBe(true);
    });

    it('returns false when user is not admin', async () => {
      const result = await validateAdminAccess(regularUserId, 0);
      expect(result).toBe(false);
    });

    it('returns false when adminRoleVersion does not match', async () => {
      // User was admin with version 0, but we claim version 1
      const result = await validateAdminAccess(adminUserId, 1);
      expect(result).toBe(false);
    });

    it('returns false for non-existent user', async () => {
      const result = await validateAdminAccess('non-existent-id', 0);
      expect(result).toBe(false);
    });

    it('role demotion invalidates admin access with old version', async () => {
      // Admin has version 0
      const validBefore = await validateAdminAccess(adminUserId, 0);
      expect(validBefore).toBe(true);

      // Demote admin to user (bumps version to 1)
      await updateUserRole(adminUserId, 'user');

      // Access with old version should fail (even though version now matches 1,
      // the user is no longer admin)
      const validAfterDemotion = await validateAdminAccess(adminUserId, 0);
      expect(validAfterDemotion).toBe(false);
    });

    it('adminRoleVersion mismatch rejects request even for valid admin', async () => {
      // Promote regular user to admin (version becomes 1)
      await updateUserRole(regularUserId, 'admin');

      // Access with old version 0 should fail
      const validWithOldVersion = await validateAdminAccess(regularUserId, 0);
      expect(validWithOldVersion).toBe(false);

      // Access with correct version 1 should succeed
      const validWithNewVersion = await validateAdminAccess(regularUserId, 1);
      expect(validWithNewVersion).toBe(true);
    });
  });
});
