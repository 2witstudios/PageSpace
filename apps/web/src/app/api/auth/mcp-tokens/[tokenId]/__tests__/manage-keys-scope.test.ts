/**
 * Red-team test: a manage-keys-only OAuth credential (Phase 9, mintable today
 * via the manage_keys scope token — see ScopeSet.manageKeys) must be able to
 * reach mcp-tokens/[tokenId] (that is exactly what the scope grants), while a
 * drive-scoped OAuth credential must still be rejected exactly as before.
 * Uses the REAL rejectScopedOAuth/isScopedOAuthAuth/isManageKeysOnly
 * implementations (not mocked) so this fails if the carve-out regresses
 * either direction.
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
    it('lets a manage_keys-only OAuth credential update drive scopes', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveIds: [] }),
      });
      const response = await PATCH(request, createContext());

      expect(response.status).toBe(200);
      expect(sessionRepository.updateMcpTokenDriveScopes).toHaveBeenCalled();
    });

    it('still rejects a drive-scoped OAuth credential, never reaching the repository', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(DRIVE_SCOPED_OAUTH as never);

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveIds: [] }),
      });
      const response = await PATCH(request, createContext());

      expect(response.status).toBe(403);
      expect(sessionRepository.updateMcpTokenDriveScopes).not.toHaveBeenCalled();
    });
  });
});
