/**
 * Contract tests for DELETE /api/auth/mcp-tokens/[tokenId]
 *
 * Tests the MCP token revocation endpoint.
 * Focuses on covering the error catch branch not tested elsewhere.
 *
 * Coverage:
 * - Authentication error handling
 * - Token not found
 * - Successful revocation
 * - Generic error catch branch (db throws)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    createMcpTokenWithDriveScopes: vi.fn(),
    findDrivesByIds: vi.fn(),
    findUserMcpTokensWithDrives: vi.fn(),
    findMcpTokenByIdAndUser: vi.fn(),
    revokeMcpToken: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com' }),
  logTokenActivity: vi.fn(),
}));

import { DELETE } from '../route';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';

const createContext = (tokenId = 'token-123') => ({
  params: Promise.resolve({ tokenId }),
});

describe('DELETE /api/auth/mcp-tokens/[tokenId]', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: 'test-user-id',
      role: 'user',
      tokenVersion: 0,
      tokenType: 'session',
      sessionId: 'test-session-id',
    } as never);
    vi.mocked(isAuthError).mockImplementation(
      (result: unknown) => result != null && typeof result === 'object' && 'error' in result
    );

    vi.mocked(getActorInfo).mockResolvedValue({ actorEmail: 'test@example.com' } as never);

    vi.mocked(sessionRepository.findMcpTokenByIdAndUser).mockResolvedValue({
      id: 'token-123',
      name: 'Test Token',
    });

    vi.mocked(sessionRepository.revokeMcpToken).mockResolvedValue(undefined);
  });

  it('returns auth error when not authenticated', async () => {
    const mockErrorResponse = Response.json({ error: 'Unauthorized' }, { status: 401 });
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: mockErrorResponse,
    } as never);

    const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': 'valid-csrf-token' },
    });

    const response = await DELETE(request, createContext());
    expect(response.status).toBe(401);
  });

  it('returns 404 when token not found', async () => {
    vi.mocked(sessionRepository.findMcpTokenByIdAndUser).mockResolvedValue(null);

    const request = new NextRequest('http://localhost/api/auth/mcp-tokens/nonexistent', {
      method: 'DELETE',
      headers: {
        Cookie: 'ps_session=valid-token',
        'X-CSRF-Token': 'valid-csrf-token',
      },
    });

    const response = await DELETE(request, createContext('nonexistent'));
    expect(response.status).toBe(404);
  });

  it('returns 200 on successful revocation', async () => {
    const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', {
      method: 'DELETE',
      headers: {
        Cookie: 'ps_session=valid-token',
        'X-CSRF-Token': 'valid-csrf-token',
      },
    });

    const response = await DELETE(request, createContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe('Token revoked successfully');
    expect(sessionRepository.revokeMcpToken).toHaveBeenCalledWith('token-123', 'test-user-id');
  });

  it('returns 500 when db throws an error', async () => {
    vi.mocked(sessionRepository.findMcpTokenByIdAndUser).mockRejectedValueOnce(
      new Error('DB connection error')
    );

    const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', {
      method: 'DELETE',
      headers: {
        Cookie: 'ps_session=valid-token',
        'X-CSRF-Token': 'valid-csrf-token',
      },
    });

    const response = await DELETE(request, createContext());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to revoke MCP token');
    expect(loggers.auth.error).toHaveBeenCalledWith(
      'Error revoking MCP token:',
      expect.any(Error)
    );
  });
});
