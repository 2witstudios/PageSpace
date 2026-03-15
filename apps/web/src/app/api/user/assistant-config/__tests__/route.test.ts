/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PUT } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/user/assistant-config
//
// Tests GET (fetch config) and PUT (update config) handlers for global
// assistant configuration per user.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/integrations', () => ({
  getOrCreateConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getOrCreateConfig, updateConfig } from '@pagespace/lib/integrations';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockConfig = (overrides: Partial<{
  enabledUserIntegrations: string[] | null;
  driveOverrides: Record<string, unknown>;
  inheritDriveIntegrations: boolean;
  createdAt: Date;
  updatedAt: Date;
}> = {}) => ({
  enabledUserIntegrations: overrides.enabledUserIntegrations ?? null,
  driveOverrides: overrides.driveOverrides ?? {},
  inheritDriveIntegrations: overrides.inheritDriveIntegrations ?? true,
  createdAt: overrides.createdAt ?? new Date('2024-01-01'),
  updatedAt: overrides.updatedAt ?? new Date('2024-01-02'),
});

// ============================================================================
// GET /api/user/assistant-config
// ============================================================================

describe('GET /api/user/assistant-config', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/user/assistant-config');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should use session-only read auth options', async () => {
      vi.mocked(getOrCreateConfig).mockResolvedValue(mockConfig());

      const request = new Request('https://example.com/api/user/assistant-config');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'] }
      );
    });
  });

  describe('success', () => {
    it('should return the assistant config', async () => {
      const config = mockConfig({
        enabledUserIntegrations: ['web-search', 'code-execution'],
        driveOverrides: { drive_1: { enabled: true } },
        inheritDriveIntegrations: false,
      });
      vi.mocked(getOrCreateConfig).mockResolvedValue(config);

      const request = new Request('https://example.com/api/user/assistant-config');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.config.enabledUserIntegrations).toEqual(['web-search', 'code-execution']);
      expect(body.config.driveOverrides).toEqual({ drive_1: { enabled: true } });
      expect(body.config.inheritDriveIntegrations).toBe(false);
    });

    it('should return config with default values', async () => {
      vi.mocked(getOrCreateConfig).mockResolvedValue(mockConfig());

      const request = new Request('https://example.com/api/user/assistant-config');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.config.enabledUserIntegrations).toBeNull();
      expect(body.config.driveOverrides).toEqual({});
      expect(body.config.inheritDriveIntegrations).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when getOrCreateConfig fails', async () => {
      vi.mocked(getOrCreateConfig).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/user/assistant-config');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch config');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(getOrCreateConfig).mockRejectedValue(error);

      const request = new Request('https://example.com/api/user/assistant-config');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching assistant config:', error);
    });
  });
});

// ============================================================================
// PUT /api/user/assistant-config
// ============================================================================

describe('PUT /api/user/assistant-config', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({ inheritDriveIntegrations: false }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(updateConfig).mockResolvedValue(mockConfig());

      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({ inheritDriveIntegrations: false }),
      });
      await PUT(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid body schema', async () => {
      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({ enabledUserIntegrations: 'not-an-array' }),
      });
      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
      expect(body.details).toBeDefined();
    });

    it('should return 400 for invalid driveOverrides shape', async () => {
      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({
          driveOverrides: { drive_1: 'invalid' },
        }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
    });
  });

  describe('success', () => {
    it('should update enabledUserIntegrations', async () => {
      const updatedConfig = mockConfig({
        enabledUserIntegrations: ['web-search'],
      });
      vi.mocked(updateConfig).mockResolvedValue(updatedConfig);

      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({ enabledUserIntegrations: ['web-search'] }),
      });
      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.config.enabledUserIntegrations).toEqual(['web-search']);
    });

    it('should update inheritDriveIntegrations', async () => {
      const updatedConfig = mockConfig({ inheritDriveIntegrations: false });
      vi.mocked(updateConfig).mockResolvedValue(updatedConfig);

      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({ inheritDriveIntegrations: false }),
      });
      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.config.inheritDriveIntegrations).toBe(false);
    });

    it('should merge driveOverrides with existing config', async () => {
      const existingConfig = mockConfig({
        driveOverrides: { drive_1: { enabled: true } },
      });
      vi.mocked(getOrCreateConfig).mockResolvedValue(existingConfig);

      const updatedConfig = mockConfig({
        driveOverrides: { drive_1: { enabled: true }, drive_2: { enabled: false } },
      });
      vi.mocked(updateConfig).mockResolvedValue(updatedConfig);

      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({
          driveOverrides: { drive_2: { enabled: false } },
        }),
      });
      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(getOrCreateConfig).toHaveBeenCalled();
    });

    it('should set enabledUserIntegrations to null', async () => {
      const updatedConfig = mockConfig({ enabledUserIntegrations: null });
      vi.mocked(updateConfig).mockResolvedValue(updatedConfig);

      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({ enabledUserIntegrations: null }),
      });
      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.config.enabledUserIntegrations).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return 500 when updateConfig fails', async () => {
      vi.mocked(updateConfig).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({ inheritDriveIntegrations: false }),
      });
      const response = await PUT(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update config');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(updateConfig).mockRejectedValue(error);

      const request = new Request('https://example.com/api/user/assistant-config', {
        method: 'PUT',
        body: JSON.stringify({ inheritDriveIntegrations: false }),
      });
      await PUT(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error updating assistant config:', error);
    });
  });
});
