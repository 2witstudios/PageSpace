/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/google-calendar/disconnect
//
// Tests the route handler's contract for disconnecting Google Calendar
// integration including token revocation and webhook cleanup.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      googleCalendarConnections: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
  googleCalendarConnections: { userId: 'userId' },
  eq: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  decrypt: vi.fn().mockResolvedValue('decrypted-access-token'),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/integrations/google-calendar/sync-service', () => ({
  unregisterWebhookChannels: vi.fn().mockResolvedValue(undefined),
}));

// Mock global fetch for token revocation
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { decrypt } from '@pagespace/lib';
import { unregisterWebhookChannels } from '@/lib/integrations/google-calendar/sync-service';
import { POST } from '../route';

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

describe('POST /api/integrations/google-calendar/disconnect', () => {
  const mockUserId = 'user_123';

  const mockConnection = {
    id: 'conn_1',
    userId: mockUserId,
    status: 'active',
    accessToken: 'encrypted-access-token',
    refreshToken: 'encrypted-refresh-token',
    googleEmail: 'user@gmail.com',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(mockConnection);
    vi.mocked(decrypt).mockResolvedValue('decrypted-access-token');
    mockFetch.mockResolvedValue({ ok: true });
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with CSRF required', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('connection lookup', () => {
    it('should return 404 when no connection found', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('No connection found');
    });
  });

  describe('token revocation', () => {
    it('should revoke Google token and unregister webhooks', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      await POST(request);

      expect(decrypt).toHaveBeenCalledWith('encrypted-access-token');
      expect(unregisterWebhookChannels).toHaveBeenCalledWith(mockUserId, 'decrypted-access-token');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://oauth2.googleapis.com/revoke'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should skip revocation if token is already REVOKED', async () => {
      vi.mocked(db.query.googleCalendarConnections.findFirst).mockResolvedValue({
        ...mockConnection,
        accessToken: 'REVOKED',
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      await POST(request);

      expect(decrypt).not.toHaveBeenCalled();
      expect(unregisterWebhookChannels).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should continue disconnecting even if token revocation fails', async () => {
      vi.mocked(decrypt).mockRejectedValue(new Error('Decryption failed'));

      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Failed to revoke Google token (continuing with disconnect)',
        expect.objectContaining({ userId: mockUserId })
      );
    });

    it('should continue if webhook unregistration fails', async () => {
      vi.mocked(unregisterWebhookChannels).mockRejectedValue(new Error('Webhook error'));

      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('success path', () => {
    it('should update connection to disconnected status', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it('should log successful disconnection', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      await POST(request);

      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Google Calendar disconnected',
        { userId: mockUserId }
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when database update fails', async () => {
      vi.mocked(db.update).mockImplementation(() => {
        throw new Error('DB error');
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to disconnect');
    });

    it('should log error when disconnect fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.update).mockImplementation(() => {
        throw error;
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/disconnect', {
        method: 'POST',
      });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error disconnecting Google Calendar:',
        error
      );
    });
  });
});
