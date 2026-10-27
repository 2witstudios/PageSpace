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
 * PATCH (updating a token's drive scopes) is session-only (AUTH_OPTIONS_PATCH
 * = { allow: ['session'] }) — no OAuth bearer credential, manage_keys-scoped
 * or otherwise, can reach this route at all. That allow-list enforcement is
 * asserted directly against the real `authenticateRequestWithOptions` in
 * route.test.ts; this file only fully mocks that function to exercise the
 * manage-keys carve-out on DELETE, so it has nothing further to test on
 * PATCH.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { manageKeysScopedAuthResult, driveScopedOAuthAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

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

import { DELETE } from '../route';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { authenticateRequestWithOptions } from '@/lib/auth';

const createContext = (tokenId = 'token-123') => ({
  params: Promise.resolve({ tokenId }),
});

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
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(driveScopedOAuthAuthResult());

      const request = new NextRequest('http://localhost/api/auth/mcp-tokens/token-123', { method: 'DELETE' });
      const response = await DELETE(request, createContext());

      expect(response.status).toBe(403);
      expect(sessionRepository.revokeMcpToken).not.toHaveBeenCalled();
    });
  });

});
