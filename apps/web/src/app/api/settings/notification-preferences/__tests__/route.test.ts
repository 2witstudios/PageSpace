/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/settings/notification-preferences
//
// Tests GET and PATCH handlers for email notification preference management.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    query: {
      emailNotificationPreferences: { findFirst: vi.fn() },
    },
  },
  emailNotificationPreferences: {
    userId: 'userId',
    notificationType: 'notificationType',
    emailEnabled: 'emailEnabled',
  },
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// ============================================================================
// GET /api/settings/notification-preferences
// ============================================================================

describe('GET /api/settings/notification-preferences', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/settings/notification-preferences');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should use session-only read auth options', async () => {
      const request = new Request('https://example.com/api/settings/notification-preferences');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('success', () => {
    it('should return all notification types with defaults when no preferences exist', async () => {
      const request = new Request('https://example.com/api/settings/notification-preferences');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.preferences).toHaveLength(11);
      // All default to true
      for (const pref of body.preferences) {
        expect(pref.emailEnabled).toBe(true);
      }
    });

    it('should include all expected notification types', async () => {
      const request = new Request('https://example.com/api/settings/notification-preferences');
      const response = await GET(request);
      const body = await response.json();

      const types = body.preferences.map((p: { notificationType: string }) => p.notificationType);
      expect(types).toContain('PERMISSION_GRANTED');
      expect(types).toContain('CONNECTION_REQUEST');
      expect(types).toContain('NEW_DIRECT_MESSAGE');
      expect(types).toContain('DRIVE_INVITED');
    });

    it('should return stored preference values overriding defaults', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { notificationType: 'CONNECTION_REQUEST', emailEnabled: false },
            { notificationType: 'DRIVE_INVITED', emailEnabled: false },
          ]),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/notification-preferences');
      const response = await GET(request);
      const body = await response.json();

      const connectionReq = body.preferences.find(
        (p: { notificationType: string }) => p.notificationType === 'CONNECTION_REQUEST'
      );
      expect(connectionReq.emailEnabled).toBe(false);

      const driveInvited = body.preferences.find(
        (p: { notificationType: string }) => p.notificationType === 'DRIVE_INVITED'
      );
      expect(driveInvited.emailEnabled).toBe(false);

      // Others still default to true
      const permGranted = body.preferences.find(
        (p: { notificationType: string }) => p.notificationType === 'PERMISSION_GRANTED'
      );
      expect(permGranted.emailEnabled).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/notification-preferences');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch notification preferences');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(error),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/notification-preferences');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching notification preferences:',
        error
      );
    });
  });
});

// ============================================================================
// PATCH /api/settings/notification-preferences
// ============================================================================

describe('PATCH /api/settings/notification-preferences', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'CONNECTION_REQUEST', emailEnabled: false }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(db.query.emailNotificationPreferences.findFirst).mockResolvedValue(null);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: '1' }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'CONNECTION_REQUEST', emailEnabled: false }),
      });
      await PATCH(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when notificationType is missing', async () => {
      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ emailEnabled: true }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('notificationType and emailEnabled are required');
    });

    it('should return 400 when emailEnabled is missing', async () => {
      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'CONNECTION_REQUEST' }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('notificationType and emailEnabled are required');
    });

    it('should return 400 when emailEnabled is not a boolean', async () => {
      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'CONNECTION_REQUEST', emailEnabled: 'no' }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('notificationType and emailEnabled are required');
    });

    it('should return 400 for invalid notification type', async () => {
      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'INVALID_TYPE', emailEnabled: true }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid notification type');
    });
  });

  describe('success - update existing', () => {
    it('should update an existing notification preference', async () => {
      const updatedPref = { id: 'pref_1', notificationType: 'CONNECTION_REQUEST', emailEnabled: false };
      vi.mocked(db.query.emailNotificationPreferences.findFirst).mockResolvedValue({
        id: 'pref_1',
        notificationType: 'CONNECTION_REQUEST',
        emailEnabled: true,
      } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedPref]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'CONNECTION_REQUEST', emailEnabled: false }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.preference).toEqual(updatedPref);
    });
  });

  describe('success - create new', () => {
    it('should create a new notification preference when none exists', async () => {
      const createdPref = { id: 'pref_new', notificationType: 'DRIVE_INVITED', emailEnabled: false };
      vi.mocked(db.query.emailNotificationPreferences.findFirst).mockResolvedValue(null);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createdPref]),
        }),
      } as any);

      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'DRIVE_INVITED', emailEnabled: false }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.preference).toEqual(createdPref);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database operation fails', async () => {
      vi.mocked(db.query.emailNotificationPreferences.findFirst).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'CONNECTION_REQUEST', emailEnabled: false }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update notification preferences');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.query.emailNotificationPreferences.findFirst).mockRejectedValue(error);

      const request = new Request('https://example.com/api/settings/notification-preferences', {
        method: 'PATCH',
        body: JSON.stringify({ notificationType: 'CONNECTION_REQUEST', emailEnabled: false }),
      });
      await PATCH(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error updating notification preferences:',
        error
      );
    });
  });
});
