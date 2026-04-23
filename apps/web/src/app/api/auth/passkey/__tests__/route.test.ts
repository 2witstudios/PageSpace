/**
 * Contract tests for GET /api/auth/passkey
 *
 * Tests the Request -> Response contract for listing user passkeys.
 * Mocks at the service seam level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('@pagespace/lib/auth/passkey-service', () => ({
    listUserPasskeys: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    security: {
      warn: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/security-audit', () => ({
    securityAudit: {
    logAuthSuccess: vi.fn().mockResolvedValue(undefined),
    logAuthFailure: vi.fn().mockResolvedValue(undefined),
    logTokenCreated: vi.fn().mockResolvedValue(undefined),
    logTokenRevoked: vi.fn().mockResolvedValue(undefined),
    logDataAccess: vi.fn().mockResolvedValue(undefined),
    logEvent: vi.fn().mockResolvedValue(undefined),
    logLogout: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateSessionRequest: vi.fn(),
  isAuthError: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

import { GET } from '../route';
import { listUserPasskeys } from '@pagespace/lib/auth/passkey-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  authenticateSessionRequest,
  isAuthError,
  getClientIP,
} from '@/lib/auth';
import { NextResponse } from 'next/server';

const createRequest = () =>
  new Request('http://localhost/api/auth/passkey', { method: 'GET' });

describe('GET /api/auth/passkey', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    // Default: authenticated user
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateSessionRequest).mockResolvedValue({
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      tokenType: 'session',
      sessionId: 'session-1',
    });
  });

  describe('successful listing', () => {
    it('returns 200 with passkeys list', async () => {
      const mockPasskeys = [
        { id: 'pk-1', name: 'My Passkey', createdAt: '2024-01-01' },
        { id: 'pk-2', name: 'Work Passkey', createdAt: '2024-02-01' },
      ];
      vi.mocked(listUserPasskeys).mockResolvedValue({
        ok: true,
        // @ts-expect-error - partial mock data
        data: { passkeys: mockPasskeys },
      });

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.passkeys).toEqual(mockPasskeys);
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    });

    it('calls listUserPasskeys with correct userId', async () => {
      vi.mocked(listUserPasskeys).mockResolvedValue({
        ok: true,
        data: { passkeys: [] },
      });

      await GET(createRequest());

      expect(listUserPasskeys).toHaveBeenCalledWith({ userId: 'user-1' });
    });
  });

  describe('authentication errors', () => {
    it('returns auth error when not authenticated', async () => {
      const authErrorResponse = NextResponse.json({ error: 'Authentication required' }, { status: 401 });
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateSessionRequest).mockResolvedValue({
        error: authErrorResponse,
      });

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });
  });

  describe('service errors', () => {
    it('returns 500 when listUserPasskeys fails', async () => {
      vi.mocked(listUserPasskeys).mockResolvedValue({
        ok: false,
        // @ts-expect-error - partial mock data
        error: { code: 'DB_ERROR', message: 'Database error' },
      });

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to list passkeys');
      expect(loggers.auth.warn).toHaveBeenCalledWith('Failed to list passkeys', {
        userId: 'user-1',
        error: 'DB_ERROR',
        ip: '127.0.0.1',
      });
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 on unexpected throw', async () => {
      vi.mocked(authenticateSessionRequest).mockRejectedValueOnce(new Error('Unexpected'));

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith('List passkeys error', new Error('Unexpected'));
    });
  });
});
