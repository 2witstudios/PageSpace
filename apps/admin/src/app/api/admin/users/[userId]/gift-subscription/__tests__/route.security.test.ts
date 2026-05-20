import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST, DELETE } from '../route';
import { NextRequest } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { sessions } from '@pagespace/db/schema/sessions'
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { createId } from '@paralleldrive/cuid2';
import { updateUserRole } from '@/lib/auth/admin-role';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';

/**
 * Security Tests for Gift Subscription Admin Routes
 *
 * These tests verify that the gift subscription admin endpoints properly
 * validate adminRoleVersion to prevent stale admin session attacks after
 * role demotion.
 *
 * Vulnerability: Stale admin session window
 * Attack Vector: Admin is demoted but existing session still carries admin role
 * Impact: Unauthorized gift subscription operations
 * Fix: Use verifyAdminAuth which validates adminRoleVersion against database
 *
 * These tests use real CSRF tokens to ensure CSRF protection is fully tested.
 */

// Mock Stripe to avoid API calls in tests
vi.mock('@/lib/stripe', () => ({
  stripe: {
    coupons: {
      create: vi.fn().mockResolvedValue({
        id: 'GIFT_mock_123',
        percent_off: 100,
      }),
    },
    subscriptions: {
      create: vi.fn().mockResolvedValue({
        id: 'sub_mock_123',
        status: 'active',
      }),
      cancel: vi.fn().mockResolvedValue({
        id: 'sub_mock_123',
        status: 'canceled',
      }),
    },
  },
  Stripe: {
    errors: {
      StripeError: class StripeError extends Error { },
    },
  },
}));

// Mock stripe customer utilities
vi.mock('@/lib/stripe-customer', () => ({
  getOrCreateStripeCustomer: vi.fn().mockResolvedValue('cus_mock_123'),
}));

// Mock stripe errors
vi.mock('@/lib/stripe-errors', () => ({
  getUserFriendlyStripeError: vi.fn((error: Error) => error.message),
}));

// Mock stripe config
vi.mock('@/lib/stripe-config', () => ({
  stripeConfig: {
    priceIds: {
      pro: 'price_pro_mock',
      founder: 'price_founder_mock',
      business: 'price_business_mock',
    },
  },
}));

// Mock loggers
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
      api: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
      auth: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      security: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
  logSecurityEvent: vi.fn(),

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { logSecurityEvent } from '@pagespace/lib/logging/logger-config';

describe('/api/admin/users/[userId]/gift-subscription - Security Tests', () => {
  let adminUserId: string;
  let regularUserId: string;
  const adminSessionToken = 'mock_admin_session_token';
  let adminCsrfToken: string;
  const mockSessionId = 'mock-session-id';

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create an admin user with adminRoleVersion 0
    const [adminUser] = await db.insert(users).values({
      id: createId(),
      name: 'Test Admin User',
      email: `admin-${Date.now()}-${createId().slice(0, 6)}@example.com`,
      provider: 'email',
      role: 'admin',
      tokenVersion: 1,
      adminRoleVersion: 0,
    }).returning();
    adminUserId = adminUser.id;

    // Create a regular user (target of gift subscription)
    const [regularUser] = await db.insert(users).values({
      id: createId(),
      name: 'Test Regular User',
      email: `regular-${Date.now()}-${createId().slice(0, 6)}@example.com`,
      provider: 'email',
      role: 'user',
      tokenVersion: 1,
      adminRoleVersion: 0,
      subscriptionTier: 'free',
    }).returning();
    regularUserId = regularUser.id;

    // Spy on sessionService to avoid the TOCTOU race condition.
    // The real createSession has a gap between user lookup and session insert —
    // another test file's cleanup can delete the user between these two DB
    // operations, causing an FK violation.
    vi.spyOn(sessionService, 'createSession').mockResolvedValue(adminSessionToken);
    vi.spyOn(sessionService, 'validateSession').mockResolvedValue({
      sessionId: mockSessionId,
      userId: adminUserId,
      userRole: 'admin',
      tokenVersion: 1,
      adminRoleVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 3600000),
    });

    // Generate real CSRF token bound to the mock session ID
    adminCsrfToken = generateCSRFToken(mockSessionId);
  });

  afterEach(async () => {
    // Clean up test data - wrapped to prevent cascading failures
    try {
      await db.delete(sessions).where(eq(sessions.userId, adminUserId));
      await db.delete(sessions).where(eq(sessions.userId, regularUserId));
      await db.delete(subscriptions).where(eq(subscriptions.userId, regularUserId));
      await db.delete(users).where(eq(users.id, adminUserId));
      await db.delete(users).where(eq(users.id, regularUserId));
    } catch {
      // Swallow cleanup errors to avoid masking test failures
    }
  });

  describe('POST - Admin role version validation', () => {
    it('POST_withValidAdminAuth_createsGiftSubscription', async () => {
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': adminCsrfToken,
          },
          body: JSON.stringify({
            tier: 'pro',
            reason: 'Test gift',
          }),
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await POST(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.tier).toBe('pro');
    });

    it('POST_afterAdminDemotion_deniesAccess', async () => {
      // Admin user is demoted to regular user
      // This increments adminRoleVersion from 0 to 1
      await updateUserRole(adminUserId, 'user');

      // Attempt to use the old session token (still has adminRoleVersion: 0)
      // The CSRF token is still valid (bound to sessionId, not role)
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': adminCsrfToken,
          },
          body: JSON.stringify({
            tier: 'pro',
            reason: 'Test gift',
          }),
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await POST(request, context);
      const body = await response.json();

      // Should be denied due to adminRoleVersion mismatch
      expect(response.status).toBe(403);
      expect(body.error).toBe('Forbidden: Admin access required');

      // Security event should be logged with detailed context
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'admin_role_version_mismatch',
        expect.objectContaining({
          reason: 'not_admin', // User was demoted, role is no longer 'admin'
          userId: adminUserId,
          claimedAdminRoleVersion: 0,
          actualAdminRoleVersion: 1,
          currentRole: 'user',
          authType: 'session',
          action: 'deny_access',
        })
      );
    });

    it('POST_afterAdminRepromotion_deniesAccessWithOldToken', async () => {
      // Demote admin to user (version becomes 1)
      await updateUserRole(adminUserId, 'user');

      // Promote back to admin (version becomes 2)
      await updateUserRole(adminUserId, 'admin');

      // Old session token still has adminRoleVersion: 0
      // CSRF token is still valid (bound to sessionId)
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': adminCsrfToken,
          },
          body: JSON.stringify({
            tier: 'pro',
            reason: 'Test gift',
          }),
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await POST(request, context);
      const body = await response.json();

      // Should be denied even though user is admin again
      // because adminRoleVersion doesn't match
      expect(response.status).toBe(403);
      expect(body.error).toBe('Forbidden: Admin access required');

      // Security event should be logged with version mismatch details
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'admin_role_version_mismatch',
        expect.objectContaining({
          reason: 'version_mismatch', // User is admin again, but version changed
          userId: adminUserId,
          claimedAdminRoleVersion: 0,
          actualAdminRoleVersion: 2, // Version 2 after demotion (1) and re-promotion (2)
          currentRole: 'admin',
        })
      );
    });

    it('POST_withoutAuth_deniesAccess', async () => {
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tier: 'pro',
            reason: 'Test gift',
          }),
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await POST(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Forbidden: Admin access required');
    });

    it('POST_withoutCSRFToken_deniesAccess', async () => {
      // Valid session but missing CSRF token
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `session=${adminSessionToken}`,
            // No X-CSRF-Token header
          },
          body: JSON.stringify({
            tier: 'pro',
            reason: 'Test gift',
          }),
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await POST(request, context);
      const body = await response.json();

      // Should be denied due to missing CSRF token
      expect(response.status).toBe(403);
      expect(body.code).toBe('CSRF_TOKEN_MISSING');
    });

    it('POST_withInvalidCSRFToken_deniesAccess', async () => {
      // Valid session but invalid CSRF token
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': 'invalid-csrf-token',
          },
          body: JSON.stringify({
            tier: 'pro',
            reason: 'Test gift',
          }),
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await POST(request, context);
      const body = await response.json();

      // Should be denied due to invalid CSRF token
      expect(response.status).toBe(403);
      expect(body.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  describe('DELETE - Admin role version validation', () => {
    beforeEach(async () => {
      // Create a subscription for the regular user to delete
      await db.insert(subscriptions).values({
        id: createId(),
        userId: regularUserId,
        stripeSubscriptionId: 'sub_test_123',
        stripePriceId: 'price_pro_mock',
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: false,
      });
    });

    it('DELETE_withValidAdminAuth_revokesSubscription', async () => {
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'DELETE',
          headers: {
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': adminCsrfToken,
          },
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('DELETE_afterAdminDemotion_deniesAccess', async () => {
      // Admin user is demoted to regular user
      await updateUserRole(adminUserId, 'user');

      // Attempt to use the old session token with valid CSRF
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'DELETE',
          headers: {
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': adminCsrfToken,
          },
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await DELETE(request, context);
      const body = await response.json();

      // Should be denied due to adminRoleVersion mismatch
      expect(response.status).toBe(403);
      expect(body.error).toBe('Forbidden: Admin access required');

      // Security event should be logged with detailed context
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'admin_role_version_mismatch',
        expect.objectContaining({
          reason: 'not_admin', // User was demoted
          userId: adminUserId,
          claimedAdminRoleVersion: 0,
          actualAdminRoleVersion: 1,
          currentRole: 'user',
          authType: 'session',
          action: 'deny_access',
        })
      );
    });

    it('DELETE_afterMultipleRoleChanges_deniesAccessWithStaleToken', async () => {
      // Multiple role changes: admin -> user -> admin -> user
      await updateUserRole(adminUserId, 'user');    // version = 1
      await updateUserRole(adminUserId, 'admin');   // version = 2
      await updateUserRole(adminUserId, 'user');    // version = 3

      // Old session token still has adminRoleVersion: 0
      // CSRF token is still valid (bound to sessionId)
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'DELETE',
          headers: {
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': adminCsrfToken,
          },
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Forbidden: Admin access required');

      // Security event should be logged with detailed context
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'admin_role_version_mismatch',
        expect.objectContaining({
          reason: 'not_admin', // Final state is user after multiple role changes
          userId: adminUserId,
          claimedAdminRoleVersion: 0,
          actualAdminRoleVersion: 3, // Version incremented 3 times
          currentRole: 'user',
        })
      );
    });

    it('DELETE_withoutAuth_deniesAccess', async () => {
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'DELETE',
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Forbidden: Admin access required');
    });
  });

  describe('Security event logging', () => {
    it('logsSecurityEvent_whenAdminRoleVersionMismatch', async () => {
      // Demote admin
      await updateUserRole(adminUserId, 'user');

      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': adminCsrfToken,
          },
          body: JSON.stringify({
            tier: 'pro',
            reason: 'Test gift',
          }),
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      await POST(request, context);

      // Verify security event was logged with correct details including actual version
      expect(logSecurityEvent).toHaveBeenCalledTimes(1);
      expect(logSecurityEvent).toHaveBeenCalledWith(
        'admin_role_version_mismatch',
        expect.objectContaining({
          reason: 'not_admin',
          userId: adminUserId,
          claimedAdminRoleVersion: 0,
          actualAdminRoleVersion: 1,
          currentRole: 'user',
          authType: 'session',
          action: 'deny_access',
        })
      );
    });

    it('doesNotLogSecurityEvent_whenAuthSucceeds', async () => {
      const request = new NextRequest(
        `http://localhost/api/admin/users/${regularUserId}/gift-subscription`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': `session=${adminSessionToken}`,
            'X-CSRF-Token': adminCsrfToken,
          },
          body: JSON.stringify({
            tier: 'pro',
            reason: 'Test gift',
          }),
        }
      );

      const context = { params: Promise.resolve({ userId: regularUserId }) };
      const response = await POST(request, context);

      // Verify auth actually succeeded (precondition for the assertion below)
      expect(response.status).toBe(200);

      // Admin role version mismatch should NOT be logged for successful auth
      const securityMismatchCalls = vi.mocked(logSecurityEvent).mock.calls.filter(
        (call) => call[0] === 'admin_role_version_mismatch'
      );
      expect(securityMismatchCalls).toHaveLength(0);
    });
  });
});
