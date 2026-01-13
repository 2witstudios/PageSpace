import { describe, it, expect } from 'vitest';
import { EnforcedAuthContext } from '../enforced-context';
import type { SessionClaims } from '../../auth/session-service';

describe('EnforcedAuthContext', () => {
  const createMockClaims = (overrides: Partial<SessionClaims> = {}): SessionClaims => ({
    sessionId: 'test-session-id',
    userId: 'test-user-id',
    userRole: 'user',
    tokenVersion: 1,
    type: 'user',
    scopes: ['files:read'],
    driveId: undefined,
    ...overrides,
  });

  describe('construction', () => {
    it('cannot be constructed directly (TypeScript enforced)', () => {
      // TypeScript prevents direct construction via private constructor
      // This test documents the design intent - TS compilation enforces it
      // @ts-expect-error - Constructor is private and inaccessible
      const attemptConstruction = () => new EnforcedAuthContext('u', 'user', [], undefined);
      // At runtime JS allows it, but TS prevents compilation
      expect(typeof attemptConstruction).toBe('function');
    });

    it('fromSession creates valid context', () => {
      const claims = createMockClaims();
      const context = EnforcedAuthContext.fromSession(claims);

      expect(context.userId).toBe('test-user-id');
      expect(context.userRole).toBe('user');
    });

    it('context is immutable (frozen)', () => {
      const claims = createMockClaims();
      const context = EnforcedAuthContext.fromSession(claims);

      expect(Object.isFrozen(context)).toBe(true);

      // Verify properties cannot be modified
      expect(() => {
        // @ts-expect-error - Testing immutability
        context.userId = 'hacked';
      }).toThrow();
    });
  });

  describe('hasScope', () => {
    it('checks exact scope match', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ scopes: ['files:read', 'files:write'] })
      );

      expect(context.hasScope('files:read')).toBe(true);
      expect(context.hasScope('files:write')).toBe(true);
      expect(context.hasScope('files:delete')).toBe(false);
    });

    it('supports wildcard (*) scope', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ scopes: ['*'] })
      );

      expect(context.hasScope('files:read')).toBe(true);
      expect(context.hasScope('files:write')).toBe(true);
      expect(context.hasScope('admin:delete')).toBe(true);
    });

    it('supports namespace wildcard (files:*)', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ scopes: ['files:*'] })
      );

      expect(context.hasScope('files:read')).toBe(true);
      expect(context.hasScope('files:write')).toBe(true);
      expect(context.hasScope('files:delete')).toBe(true);
      expect(context.hasScope('admin:read')).toBe(false);
    });

    it('returns false for empty scopes', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ scopes: [] })
      );

      expect(context.hasScope('files:read')).toBe(false);
    });
  });

  describe('isAdmin', () => {
    it('returns true for admin role', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ userRole: 'admin' })
      );

      expect(context.isAdmin()).toBe(true);
    });

    it('returns false for user role', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ userRole: 'user' })
      );

      expect(context.isAdmin()).toBe(false);
    });
  });

  describe('isBoundToResource', () => {
    it('returns true when no resource binding (unrestricted)', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ resourceType: undefined, resourceId: undefined })
      );

      expect(context.isBoundToResource('page', 'any-page-id')).toBe(true);
      expect(context.isBoundToResource('drive', 'any-drive-id')).toBe(true);
    });

    it('returns true when resource matches binding', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ resourceType: 'page', resourceId: 'page-123' })
      );

      expect(context.isBoundToResource('page', 'page-123')).toBe(true);
    });

    it('returns false when resource type mismatches', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ resourceType: 'page', resourceId: 'page-123' })
      );

      expect(context.isBoundToResource('drive', 'page-123')).toBe(false);
    });

    it('returns false when resource id mismatches', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ resourceType: 'page', resourceId: 'page-123' })
      );

      expect(context.isBoundToResource('page', 'page-456')).toBe(false);
    });
  });

  describe('resource binding accessor', () => {
    it('exposes resourceBinding when present', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ resourceType: 'page', resourceId: 'page-123' })
      );

      expect(context.resourceBinding).toEqual({ type: 'page', id: 'page-123' });
    });

    it('returns undefined when no binding', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ resourceType: undefined, resourceId: undefined })
      );

      expect(context.resourceBinding).toBeUndefined();
    });
  });

  describe('driveId accessor', () => {
    it('exposes driveId when present', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ driveId: 'drive-123' })
      );

      expect(context.driveId).toBe('drive-123');
    });

    it('returns undefined when no driveId', () => {
      const context = EnforcedAuthContext.fromSession(
        createMockClaims({ driveId: undefined })
      );

      expect(context.driveId).toBeUndefined();
    });
  });
});
