import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('../session-service', () => ({
  sessionService: {
    createSession: vi.fn(),
    validateSession: vi.fn(),
    revokeAllUserSessions: vi.fn(),
  },
}));

vi.mock('../constants', () => ({
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock('../csrf-utils', () => ({
  generateCSRFToken: vi.fn(),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('../device-auth-utils', () => ({
  validateOrCreateDeviceToken: vi.fn(),
}));

import { createDesktopSession } from '../desktop-session';
import { sessionService } from '../session-service';
import { generateCSRFToken } from '../csrf-utils';
import { validateOrCreateDeviceToken } from '../device-auth-utils';

const mockParams = {
  userId: 'user-123',
  deviceId: 'device-456',
  deviceName: 'Test Desktop',
  provider: 'passkey',
  clientIP: '127.0.0.1',
  userAgent: 'Electron/33',
  tokenVersion: 0,
};

describe('createDesktopSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a session, CSRF token, and device token', async () => {
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_test123');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'sess-id-1',
      userId: 'user-123',
      userRole: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 86400000),
    });
    vi.mocked(generateCSRFToken).mockReturnValue('csrf-token-abc');
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'ps_dev_token789',
      deviceTokenRecordId: 'dt-record-1',
      isNew: true,
    });

    const result = await createDesktopSession(mockParams);

    expect(result).toEqual({
      sessionToken: 'ps_sess_test123',
      csrfToken: 'csrf-token-abc',
      deviceToken: 'ps_dev_token789',
    });
  });

  it('should revoke existing sessions before creating a new one', async () => {
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(2);
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_new');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'sess-id-2',
      userId: 'user-123',
      type: 'user',
      scopes: ['*'],
      userRole: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      expiresAt: new Date(Date.now() + 86400000),
    });
    vi.mocked(generateCSRFToken).mockReturnValue('csrf-2');
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'ps_dev_2',
      deviceTokenRecordId: 'dt-2',
      isNew: false,
    });

    await createDesktopSession(mockParams);

    expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
      'user-123',
      'desktop_passkey_login'
    );
  });

  it('should pass correct params to createSession', async () => {
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_x');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'sid',
      userId: 'user-123',
      type: 'user',
      scopes: ['*'],
      userRole: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      expiresAt: new Date(Date.now() + 86400000),
    });
    vi.mocked(generateCSRFToken).mockReturnValue('csrf');
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'dt',
      deviceTokenRecordId: 'dtr',
      isNew: true,
    });

    await createDesktopSession(mockParams);

    expect(sessionService.createSession).toHaveBeenCalledWith({
      userId: 'user-123',
      type: 'user',
      scopes: ['*'],
      expiresInMs: 7 * 24 * 60 * 60 * 1000,
      createdByIp: '127.0.0.1',
    });
  });

  it('should pass correct params to validateOrCreateDeviceToken', async () => {
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_x');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'sid',
      userId: 'user-123',
      type: 'user',
      scopes: ['*'],
      userRole: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      expiresAt: new Date(Date.now() + 86400000),
    });
    vi.mocked(generateCSRFToken).mockReturnValue('csrf');
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'dt',
      deviceTokenRecordId: 'dtr',
      isNew: true,
    });

    await createDesktopSession(mockParams);

    expect(validateOrCreateDeviceToken).toHaveBeenCalledWith({
      providedDeviceToken: undefined,
      userId: 'user-123',
      deviceId: 'device-456',
      platform: 'desktop',
      tokenVersion: 0,
      deviceName: 'Test Desktop',
      userAgent: 'Electron/33',
      ipAddress: '127.0.0.1',
    });
  });

  it('should generate CSRF token from the session ID', async () => {
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_x');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'my-session-id',
      userId: 'user-123',
      type: 'user',
      scopes: ['*'],
      userRole: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      expiresAt: new Date(Date.now() + 86400000),
    });
    vi.mocked(generateCSRFToken).mockReturnValue('csrf-from-session');
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'dt',
      deviceTokenRecordId: 'dtr',
      isNew: true,
    });

    await createDesktopSession(mockParams);

    expect(generateCSRFToken).toHaveBeenCalledWith('my-session-id');
  });

  it('should throw if session validation fails', async () => {
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_x');
    vi.mocked(sessionService.validateSession).mockResolvedValue(null);

    await expect(createDesktopSession(mockParams)).rejects.toThrow(
      'Failed to validate newly created desktop session'
    );
  });

  it('should not include clientIP when it is "unknown"', async () => {
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_x');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'sid',
      userId: 'user-123',
      type: 'user',
      scopes: ['*'],
      userRole: 'user',
      tokenVersion: 0,
      adminRoleVersion: 0,
      expiresAt: new Date(Date.now() + 86400000),
    });
    vi.mocked(generateCSRFToken).mockReturnValue('csrf');
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'dt',
      deviceTokenRecordId: 'dtr',
      isNew: true,
    });

    await createDesktopSession({ ...mockParams, clientIP: 'unknown' });

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByIp: undefined,
      })
    );
  });
});
