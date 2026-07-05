import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    validateSession: vi.fn(),
  },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logSecurityEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('../admin-role', () => ({
  validateAdminAccess: vi.fn(),
}));
vi.mock('../csrf-validation', () => ({
  validateCSRF: vi.fn(),
}));
vi.mock('../cookie-config', () => ({
  getSessionFromCookies: vi.fn(),
}));

import { verifyAdminAuth, isAdminAuthError } from '../auth';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { validateAdminAccess } from '../admin-role';
import { validateCSRF } from '../csrf-validation';
import { getSessionFromCookies } from '../cookie-config';

describe('admin verifyAdminAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionFromCookies).mockReturnValue('some-cookie-token');
    vi.mocked(validateCSRF).mockResolvedValue(null);
    vi.mocked(validateAdminAccess).mockResolvedValue({ isValid: true } as never);
  });

  function makeRequest(method = 'GET') {
    return new Request('https://admin.example.com/api/whatever', {
      method,
      headers: { cookie: 'session=some-cookie-token' },
    });
  }

  it('scopes the admin session cookie to user-type sessions only', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'sess-1',
      userId: 'user-1',
      userRole: 'admin',
      tokenVersion: 1,
      adminRoleVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 60000),
    });

    await verifyAdminAuth(makeRequest());

    expect(sessionService.validateSession).toHaveBeenCalledWith('some-cookie-token', { expectedType: 'user' });
  });

  it('rejects a non-user token (e.g. a leaked socket/service/mcp/device token) placed in the admin session cookie', async () => {
    // Real sessionService.validateSession would return null here because the
    // stored session's type doesn't match the required 'user' expectedType —
    // simulate that behavior directly since sessionService is mocked.
    vi.mocked(sessionService.validateSession).mockResolvedValue(null);

    const result = await verifyAdminAuth(makeRequest());

    expect(isAdminAuthError(result)).toBe(true);
    if (isAdminAuthError(result)) {
      expect(result.status).toBe(403);
    }
  });
});
