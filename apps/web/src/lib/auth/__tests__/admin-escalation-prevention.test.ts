/**
 * Admin Role Escalation Prevention Tests
 *
 * Zero-trust tests for admin role race condition prevention.
 * These verify that the adminRoleVersion mechanism prevents
 * timing attacks where a user's admin status changes between
 * token issuance and request validation.
 *
 * Security properties tested:
 * 1. Demoted admin cannot use stale tokens
 * 2. Promoted user needs new token with correct version
 * 3. Version must match exactly — no off-by-one tolerance
 * 4. Non-existent users always denied
 * 5. Role change + version mismatch = denial
 * 6. Multiple rapid role changes increment version correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mocks
// =============================================================================

const mockFindFirst = vi.fn();
const mockUpdateReturning = vi.fn();

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockUpdateReturning,
        })),
      })),
    })),
  },
  users: {
    id: 'users.id',
    role: 'users.role',
    adminRoleVersion: 'users.adminRoleVersion',
  },
  eq: vi.fn(),
  sql: vi.fn(),
}));

import { validateAdminAccess } from '../admin-role';

describe('Admin Escalation Prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // 1. ADMIN DEMOTION WITH STALE TOKEN
  // ===========================================================================

  describe('admin demotion with stale token', () => {
    it('given admin demoted to user, stale token with old version should be rejected', async () => {
      // User was demoted: role is now 'user', version bumped from 0 to 1
      mockFindFirst.mockResolvedValue({
        role: 'user',
        adminRoleVersion: 1,
      });

      // Token was issued when version was 0
      const result = await validateAdminAccess('user-ex-admin', 0);

      expect(result.isValid).toBe(false);
    });

    it('given admin demoted to user, even correct version should fail because role is user', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'user',
        adminRoleVersion: 1,
      });

      // Even with matching version, role is not admin
      const result = await validateAdminAccess('user-ex-admin', 1);

      expect(result.isValid).toBe(false);
    });
  });

  // ===========================================================================
  // 2. PROMOTION REQUIRES NEW TOKEN
  // ===========================================================================

  describe('promotion requires fresh token', () => {
    it('given user promoted to admin, old token with version 0 should be rejected', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 1, // Bumped to 1 on promotion
      });

      // Old token had version 0
      const result = await validateAdminAccess('user-new-admin', 0);

      expect(result.isValid).toBe(false);
    });

    it('given user promoted to admin, new token with correct version should succeed', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 1,
      });

      const result = await validateAdminAccess('user-new-admin', 1);

      expect(result.isValid).toBe(true);
    });
  });

  // ===========================================================================
  // 3. VERSION PRECISION
  // ===========================================================================

  describe('version precision', () => {
    it('given version off by +1, should reject', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 5,
      });

      const result = await validateAdminAccess('user-admin', 6);

      expect(result.isValid).toBe(false);
    });

    it('given version off by -1, should reject', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 5,
      });

      const result = await validateAdminAccess('user-admin', 4);

      expect(result.isValid).toBe(false);
    });

    it('given exact version match with admin role, should accept', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 5,
      });

      const result = await validateAdminAccess('user-admin', 5);

      expect(result.isValid).toBe(true);
    });

    it('given version 0 with actual version 0 and admin role, should accept', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 0,
      });

      const result = await validateAdminAccess('user-admin', 0);

      expect(result.isValid).toBe(true);
    });

    it('given negative claimed version, should reject', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 0,
      });

      const result = await validateAdminAccess('user-admin', -1);

      expect(result.isValid).toBe(false);
    });
  });

  // ===========================================================================
  // 4. NON-EXISTENT USER
  // ===========================================================================

  describe('non-existent user', () => {
    it('given non-existent userId, should deny access', async () => {
      mockFindFirst.mockResolvedValue(null);

      const result = await validateAdminAccess('user-nonexistent', 0);

      expect(result.isValid).toBe(false);
    });

    it('given undefined user lookup result, should deny access', async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const result = await validateAdminAccess('user-deleted', 0);

      expect(result.isValid).toBe(false);
    });
  });

  // ===========================================================================
  // 5. RAPID ROLE CHANGES (RACE CONDITION SCENARIO)
  // ===========================================================================

  describe('rapid role changes', () => {
    it('given user promoted then immediately demoted, stale admin token should fail', async () => {
      // User went: user(v0) -> admin(v1) -> user(v2)
      // Token was captured at v1 (admin)
      mockFindFirst.mockResolvedValue({
        role: 'user', // Now a regular user
        adminRoleVersion: 2,
      });

      const result = await validateAdminAccess('user-flipflop', 1);

      expect(result.isValid).toBe(false);
    });

    it('given high version number from many changes, only exact match succeeds', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 100,
      });

      expect((await validateAdminAccess('user-admin', 99)).isValid).toBe(false);
      expect((await validateAdminAccess('user-admin', 100)).isValid).toBe(true);
      expect((await validateAdminAccess('user-admin', 101)).isValid).toBe(false);
    });
  });

  // ===========================================================================
  // 6. THREE-CHECK SECURITY GATE
  // ===========================================================================

  describe('three-check security gate (user exists, is admin, version matches)', () => {
    it('gate 1 fail: user does not exist', async () => {
      mockFindFirst.mockResolvedValue(null);

      expect((await validateAdminAccess('ghost', 0)).isValid).toBe(false);
    });

    it('gate 2 fail: user exists but is not admin', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'user',
        adminRoleVersion: 0,
      });

      expect((await validateAdminAccess('user-regular', 0)).isValid).toBe(false);
    });

    it('gate 3 fail: user is admin but version mismatches', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 2,
      });

      expect((await validateAdminAccess('user-admin', 1)).isValid).toBe(false);
    });

    it('all gates pass: user exists, is admin, version matches', async () => {
      mockFindFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 2,
      });

      expect((await validateAdminAccess('user-admin', 2)).isValid).toBe(true);
    });
  });
});
