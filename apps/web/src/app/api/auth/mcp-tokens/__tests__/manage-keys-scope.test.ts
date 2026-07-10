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
 * POST is session-only (AUTH_OPTIONS_WRITE = { allow: ['session'] }) — no
 * OAuth bearer credential, manage_keys-scoped or otherwise, can reach this
 * route at all, regardless of any request body. The CLI mints a scoped
 * mcp_* credential exclusively through the separate OAuth authorize/consent
 * flow (`pagespace keys create`), which has its own step-up gate — this
 * REST route's step-up requirement was removed as web-UI-only and
 * redundant with that (see #1927). That allow-list enforcement is asserted
 * directly against the real `authenticateRequestWithOptions` in
 * route.test.ts; this file only fully mocks that function to exercise the
 * manage-keys carve-out on GET, so it has nothing further to test on POST.
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
vi.mock('@/lib/auth/request-auth', async (importOriginal) => ({
  ...(await importOriginal()),
  authenticateRequestWithOptions: vi.fn(),
}));

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

import { GET } from '../route';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

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
