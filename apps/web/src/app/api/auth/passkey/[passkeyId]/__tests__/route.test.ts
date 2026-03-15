/**
 * Contract tests for DELETE/PATCH /api/auth/passkey/[passkeyId]
 *
 * Tests the Request -> Response contract for deleting and updating passkeys.
 * Mocks at the service seam level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('@pagespace/lib/auth', () => ({
  deletePasskey: vi.fn(),
  updatePasskeyName: vi.fn(),
  validateCSRFToken: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  logSecurityEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateSessionRequest: vi.fn(),
  isAuthError: vi.fn(),
  isSessionAuthResult: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

import { DELETE, PATCH } from '../route';
import { deletePasskey, updatePasskeyName, validateCSRFToken } from '@pagespace/lib/auth';
import { loggers, logSecurityEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { authenticateSessionRequest, isAuthError, isSessionAuthResult, getClientIP } from '@/lib/auth';
import { NextResponse } from 'next/server';

const createContext = (passkeyId = 'test-passkey-id') => ({
  params: Promise.resolve({ passkeyId }),
});

const createDeleteRequest = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/auth/passkey/test-passkey-id', {
    method: 'DELETE',
    headers: {
      'x-csrf-token': 'valid-csrf-token',
      ...headers,
    },
  });

const createPatchRequest = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/auth/passkey/test-passkey-id', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': 'valid-csrf-token',
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe('DELETE /api/auth/passkey/[passkeyId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isSessionAuthResult).mockReturnValue(true);
    vi.mocked(authenticateSessionRequest).mockResolvedValue({
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      tokenType: 'session',
      sessionId: 'session-1',
    });
    vi.mocked(validateCSRFToken).mockReturnValue(true);
  });

  describe('successful deletion', () => {
    it('returns success on valid delete', async () => {
      vi.mocked(deletePasskey).mockResolvedValue({ ok: true, data: {} });

      const response = await DELETE(createDeleteRequest(), createContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('calls deletePasskey with userId and passkeyId', async () => {
      vi.mocked(deletePasskey).mockResolvedValue({ ok: true, data: {} });

      await DELETE(createDeleteRequest(), createContext('pk-123'));

      expect(deletePasskey).toHaveBeenCalledWith({ userId: 'user-1', passkeyId: 'pk-123' });
    });

    it('tracks passkey deletion event', async () => {
      vi.mocked(deletePasskey).mockResolvedValue({ ok: true, data: {} });

      await DELETE(createDeleteRequest(), createContext());

      expect(trackAuthEvent).toHaveBeenCalledWith('user-1', 'passkey_deleted', expect.objectContaining({
        ip: '127.0.0.1',
        passkeyId: 'test-passkey-id',
      }));
      expect(loggers.auth.info).toHaveBeenCalledWith('Passkey deleted', expect.objectContaining({
        userId: 'user-1',
        passkeyId: 'test-passkey-id',
      }));
    });
  });

  describe('authentication errors', () => {
    it('returns auth error when not authenticated', async () => {
      const authErrorResponse = NextResponse.json({ error: 'Authentication required' }, { status: 401 });
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateSessionRequest).mockResolvedValue({ error: authErrorResponse });

      const response = await DELETE(createDeleteRequest(), createContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });
  });

  describe('CSRF validation', () => {
    it('returns 403 when CSRF token is missing', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const request = new Request('http://localhost/api/auth/passkey/test-passkey-id', {
        method: 'DELETE',
      });

      const response = await DELETE(request, createContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
    });

    it('returns 403 when CSRF token is invalid', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const response = await DELETE(createDeleteRequest({ 'x-csrf-token': 'bad-token' }), createContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
      expect(logSecurityEvent).toHaveBeenCalledWith('passkey_csrf_invalid', expect.objectContaining({
        flow: 'delete',
      }));
    });

    it('skips CSRF validation for Bearer token auth', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(true);
      vi.mocked(validateCSRFToken).mockReturnValue(false);
      vi.mocked(deletePasskey).mockResolvedValue({ ok: true, data: {} });

      const request = new Request('http://localhost/api/auth/passkey/test-passkey-id', {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ps_sess_token' },
      });

      const response = await DELETE(request, createContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('skips CSRF validation when sessionId is null (non-session auth)', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(false);
      vi.mocked(deletePasskey).mockResolvedValue({ ok: true, data: {} });

      const request = new Request('http://localhost/api/auth/passkey/test-passkey-id', {
        method: 'DELETE',
      });

      const response = await DELETE(request, createContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('service errors', () => {
    it('returns 404 when passkey not found', async () => {
      vi.mocked(deletePasskey).mockResolvedValue({
        ok: false,
        error: { code: 'PASSKEY_NOT_FOUND', message: 'Not found' },
      });

      const response = await DELETE(createDeleteRequest(), createContext());
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Passkey not found');
    });

    it('returns 500 on generic service error', async () => {
      vi.mocked(deletePasskey).mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Database error' },
      });

      const response = await DELETE(createDeleteRequest(), createContext());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete passkey');
      expect(loggers.auth.warn).toHaveBeenCalledWith('Failed to delete passkey', expect.objectContaining({
        error: 'DB_ERROR',
      }));
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 on unexpected throw', async () => {
      vi.mocked(authenticateSessionRequest).mockRejectedValue(new Error('Unexpected'));

      const response = await DELETE(createDeleteRequest(), createContext());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith('Delete passkey error', expect.any(Error));
    });
  });
});

describe('PATCH /api/auth/passkey/[passkeyId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isSessionAuthResult).mockReturnValue(true);
    vi.mocked(authenticateSessionRequest).mockResolvedValue({
      userId: 'user-1',
      role: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      tokenType: 'session',
      sessionId: 'session-1',
    });
    vi.mocked(validateCSRFToken).mockReturnValue(true);
  });

  describe('successful update', () => {
    it('returns success on valid name update', async () => {
      vi.mocked(updatePasskeyName).mockResolvedValue({ ok: true, data: {} });

      const response = await PATCH(
        createPatchRequest({ name: 'New Name' }),
        createContext(),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('calls updatePasskeyName with correct params', async () => {
      vi.mocked(updatePasskeyName).mockResolvedValue({ ok: true, data: {} });

      await PATCH(createPatchRequest({ name: 'Updated' }), createContext('pk-456'));

      expect(updatePasskeyName).toHaveBeenCalledWith({
        userId: 'user-1',
        passkeyId: 'pk-456',
        name: 'Updated',
      });
    });

    it('logs passkey renamed event', async () => {
      vi.mocked(updatePasskeyName).mockResolvedValue({ ok: true, data: {} });

      await PATCH(createPatchRequest({ name: 'Updated' }), createContext());

      expect(loggers.auth.info).toHaveBeenCalledWith('Passkey renamed', expect.objectContaining({
        userId: 'user-1',
        passkeyId: 'test-passkey-id',
      }));
    });
  });

  describe('authentication errors', () => {
    it('returns auth error when not authenticated', async () => {
      const authErrorResponse = NextResponse.json({ error: 'Authentication required' }, { status: 401 });
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateSessionRequest).mockResolvedValue({ error: authErrorResponse });

      const response = await PATCH(createPatchRequest({ name: 'Test' }), createContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });
  });

  describe('CSRF validation', () => {
    it('returns 403 when CSRF token is invalid', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const response = await PATCH(
        createPatchRequest({ name: 'Test' }, { 'x-csrf-token': 'bad' }),
        createContext(),
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
      expect(logSecurityEvent).toHaveBeenCalledWith('passkey_csrf_invalid', expect.objectContaining({
        flow: 'update',
      }));
    });

    it('returns 403 when CSRF token is missing', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const request = new Request('http://localhost/api/auth/passkey/test-passkey-id', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });

      const response = await PATCH(request, createContext());
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Invalid CSRF token');
    });

    it('skips CSRF validation for Bearer token auth', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(true);
      vi.mocked(validateCSRFToken).mockReturnValue(false);
      vi.mocked(updatePasskeyName).mockResolvedValue({ ok: true, data: {} });

      const request = new Request('http://localhost/api/auth/passkey/test-passkey-id', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ps_sess_token',
        },
        body: JSON.stringify({ name: 'Test' }),
      });

      const response = await PATCH(request, createContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('skips CSRF validation when sessionId is null', async () => {
      vi.mocked(isSessionAuthResult).mockReturnValue(false);
      vi.mocked(updatePasskeyName).mockResolvedValue({ ok: true, data: {} });

      const request = new Request('http://localhost/api/auth/passkey/test-passkey-id', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });

      const response = await PATCH(request, createContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing name', async () => {
      const response = await PATCH(createPatchRequest({}), createContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
      expect(body.details).toBeDefined();
    });

    it('returns 400 for empty name', async () => {
      const response = await PATCH(createPatchRequest({ name: '' }), createContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });

    it('returns 400 for name exceeding 255 characters', async () => {
      const response = await PATCH(createPatchRequest({ name: 'a'.repeat(256) }), createContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request body');
    });
  });

  describe('service errors', () => {
    it('returns 404 when passkey not found', async () => {
      vi.mocked(updatePasskeyName).mockResolvedValue({
        ok: false,
        error: { code: 'PASSKEY_NOT_FOUND', message: 'Not found' },
      });

      const response = await PATCH(createPatchRequest({ name: 'Test' }), createContext());
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Passkey not found');
    });

    it('returns 400 when validation fails', async () => {
      vi.mocked(updatePasskeyName).mockResolvedValue({
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'Invalid name' },
      });

      const response = await PATCH(createPatchRequest({ name: 'Test' }), createContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid name');
    });

    it('returns 500 on generic service error', async () => {
      vi.mocked(updatePasskeyName).mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Database error' },
      });

      const response = await PATCH(createPatchRequest({ name: 'Test' }), createContext());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update passkey');
      expect(loggers.auth.warn).toHaveBeenCalledWith('Failed to update passkey name', expect.objectContaining({
        error: 'DB_ERROR',
      }));
    });
  });

  describe('unexpected errors', () => {
    it('returns 500 on unexpected throw', async () => {
      vi.mocked(authenticateSessionRequest).mockRejectedValue(new Error('Unexpected'));

      const response = await PATCH(createPatchRequest({ name: 'Test' }), createContext());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
      expect(loggers.auth.error).toHaveBeenCalledWith('Update passkey error', expect.any(Error));
    });
  });
});
