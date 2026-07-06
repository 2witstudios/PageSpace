/**
 * Red-team test for the manage_keys-only OAuth carve-out (Phase 9 — see
 * ScopeSet.manageKeys) against mcp-tokens/[tokenId].
 *
 * DELETE only narrows a credential's footprint (revocation, never escalation),
 * so it is reachable by a manage_keys credential exactly as designed, while a
 * drive-scoped OAuth credential is still rejected — this uses the REAL
 * rejectScopedOAuth/isScopedOAuthAuth/isManageKeysOnly implementations (not
 * mocked) so it fails if that carve-out regresses either direction.
 *
 * PATCH (updating a token's drive scopes) is credential *escalation*, which
 * Phase 8's step-up gate requires for every caller regardless of credential
 * shape — a manage_keys OAuth bearer token is itself an ambient secret, so it
 * gets no exception. AUTH_OPTIONS_PATCH only allows 'session' here, so an
 * oauth-shaped auth object (however it arrived) is stopped by the step-up
 * gate before any scope check runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { manageKeysScopedAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    findMcpTokenByIdAndUser: vi.fn(),
    revokeMcpToken: vi.fn(),
    updateMcpTokenDriveScopes: vi.fn(),
    findDrivesByIds: vi.fn(),
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
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com' }),
  logTokenActivity: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-service', () => ({
  validateDriveScopeAccess: vi.fn(),
}));

import { DELETE, PATCH } from '../route';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { authenticateRequestWithOptions } from '@/lib/auth';

const createContext = (tokenId = 'token-123') => ({
  params: Promise.resolve({ tokenId }),
});

const DRIVE_SCOPED_OAUTH = {
  tokenType: 'oauth' as const,
  userId: 'test-user-id',
  role: 'user' as const,
  tokenVersion: 0,
  adminRoleVersion: 0,
  tokenId: 'oauth-token-1',
  scopes: {
    account: false,
    offlineAccess: false,
    manageKeys: false,
    drives: new Map([['drive-1', { kind: 'drive' as const, driveId: 'drive-1', role: { kind: 'inherit' as const } }]]),
  },
  driveScopes: [{ driveId: 'drive-1', role: null, customRoleId: null }],
  allowedDriveIds: ['drive-1'],
};

describe('mcp-tokens/[tokenId] routes — manage_keys-only vs drive-scoped OAuth (real isScopedOAuthAuth/isManageKeysOnly)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionRepository.findMcpTokenByIdAndUser).mockResolvedValue({
      id: 'token-123',
      name: 'Test Token',
    } as never);
    vi.mocked(sessionRepository.revokeMcpToken).mockResolvedValue(undefined as never);
    vi.mocked(sessionRepository.updateMcpTokenDriveScopes).mockResolvedValue(undefined as never);
    vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([]);
  });

  describe('DELETE /api/auth/mcp-tokens/[tokenId]', () => {
    it('lets a manage_keys-only OAuth credential revoke an mcp token', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', { method: 'DELETE' });
      const response = await DELETE(request, createContext());

      expect(response.status).toBe(200);
      expect(sessionRepository.revokeMcpToken).toHaveBeenCalled();
    });

    it('still rejects a drive-scoped OAuth credential, never reaching the repository', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(DRIVE_SCOPED_OAUTH as never);

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', { method: 'DELETE' });
      const response = await DELETE(request, createContext());

      expect(response.status).toBe(403);
      expect(sessionRepository.revokeMcpToken).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/auth/mcp-tokens/[tokenId]', () => {
    it('does not exempt a manage_keys-only OAuth credential from the step-up gate — no stepUpToken means 401, never a scope update', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveIds: [] }),
      });
      const response = await PATCH(request, createContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('step_up_required');
      expect(sessionRepository.updateMcpTokenDriveScopes).not.toHaveBeenCalled();
    });

    it('still rejects a drive-scoped OAuth credential the same way — step-up gate fires before any scope check, never reaching the repository', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(DRIVE_SCOPED_OAUTH as never);

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveIds: [] }),
      });
      const response = await PATCH(request, createContext());
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('step_up_required');
      expect(sessionRepository.updateMcpTokenDriveScopes).not.toHaveBeenCalled();
    });
  });
});
