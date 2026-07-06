/**
 * Red-team test for the manage_keys-only OAuth carve-out (Phase 9 — see
 * ScopeSet.manageKeys) against mcp-tokens.
 *
 * GET is read-only and reachable by a manage_keys credential exactly as
 * designed, while a drive-scoped OAuth credential is still rejected — this
 * uses the REAL rejectScopedOAuth/isScopedOAuthAuth/isManageKeysOnly
 * implementations (not mocked) so it fails if that carve-out regresses
 * either direction.
 *
 * POST is credential *minting*, which Phase 8's step-up gate requires for
 * every caller regardless of credential shape — a manage_keys OAuth bearer
 * token is itself an ambient secret, so it gets no exception. Minting via a
 * manage_keys credential goes through the same session + step-up
 * browser-consent flow (`pagespace tokens create`) as everyone else, not a
 * direct bearer POST; AUTH_OPTIONS_WRITE only allows 'session' here, so an
 * oauth-shaped auth object (however it arrived) is stopped by the step-up
 * gate before any scope check runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { manageKeysScopedAuthResult, driveScopedOAuthAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    createMcpTokenWithDriveScopes: vi.fn(),
    findDrivesByIds: vi.fn(),
    findUserMcpTokensWithDrives: vi.fn(),
  },
}));

// Only stub authentication — rejectScopedOAuth, isScopedOAuthAuth, and
// isManageKeysOnly run for real.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    authenticateRequestWithOptions: vi.fn(),
  };
});

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    security: {
      warn: vi.fn(),
    },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/auth/token-utils', () => ({
  generateToken: vi.fn().mockReturnValue({
    token: 'mcp_randomBase64UrlString',
    hash: 'mockTokenHash123',
    tokenPrefix: 'mcp_randomBas',
  }),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com' }),
  logTokenActivity: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-service', () => ({
  validateDriveScopeAccess: vi.fn(),
}));

import { POST, GET } from '../route';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { authenticateRequestWithOptions } from '@/lib/auth';

describe('mcp-tokens routes — manage_keys-only vs drive-scoped OAuth (real isScopedOAuthAuth/isManageKeysOnly)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mockResolvedValue({
      id: 'new-mcp-token-id',
      name: 'Test Token',
      createdAt: new Date(),
    } as never);
    vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([]);
    vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([]);
  });

  describe('POST /api/auth/mcp-tokens', () => {
    it('does not exempt a manage_keys-only OAuth credential from the step-up gate — no stepUpToken means 401, never a mint', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Token' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('step_up_required');
      expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
    });

    it('still rejects a drive-scoped OAuth credential the same way — step-up gate fires before any scope check, never reaching the repository', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(driveScopedOAuthAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Token' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('step_up_required');
      expect(sessionRepository.createMcpTokenWithDriveScopes).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/auth/mcp-tokens', () => {
    it('lets a manage_keys-only OAuth credential list mcp tokens', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens', { method: 'GET' });
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(sessionRepository.findUserMcpTokensWithDrives).toHaveBeenCalled();
    });

    it('still rejects a drive-scoped OAuth credential, never reaching the repository', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(driveScopedOAuthAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens', { method: 'GET' });
      const response = await GET(request);

      expect(response.status).toBe(403);
      expect(sessionRepository.findUserMcpTokensWithDrives).not.toHaveBeenCalled();
    });
  });
});
