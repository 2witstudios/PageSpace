/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/integrations/providers/install
//
// Tests the route handler for installing builtin providers. Admin only.
// Uses verifyAdminAuth instead of authenticateRequestWithOptions.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@/lib/auth', () => ({
  verifyAdminAuth: vi.fn(),
  isAdminAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/integrations', () => ({
  getBuiltinProvider: vi.fn(),
  getProviderBySlug: vi.fn(),
  createProvider: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { verifyAdminAuth, isAdminAuthError } from '@/lib/auth';
import { getBuiltinProvider, getProviderBySlug, createProvider } from '@pagespace/lib/integrations';
import { POST } from '../route';

const mockAdminUser = {
  id: 'admin_123',
  role: 'admin' as const,
  tokenVersion: 0,
  adminRoleVersion: 0,
  authTransport: 'cookie' as const,
};

describe('POST /api/integrations/providers/install', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAdminAuth).mockResolvedValue(mockAdminUser as any);
    vi.mocked(isAdminAuthError).mockReturnValue(false);
    vi.mocked(getBuiltinProvider).mockReturnValue({
      id: 'github',
      name: 'GitHub',
      description: 'GitHub integration',
      iconUrl: 'https://icon.example.com/github.png',
      documentationUrl: 'https://docs.github.com',
    } as any);
    vi.mocked(getProviderBySlug).mockResolvedValue(null as any);
    vi.mocked(createProvider).mockResolvedValue({
      id: 'provider_1',
      slug: 'github',
      name: 'GitHub',
    } as any);
  });

  describe('authentication', () => {
    it('should return auth error when not admin', async () => {
      const authErrorResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      vi.mocked(verifyAdminAuth).mockResolvedValue(authErrorResponse as any);
      vi.mocked(isAdminAuthError).mockReturnValue(true);

      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinId: 'github' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when builtinId is missing', async () => {
      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 when builtinId is empty', async () => {
      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinId: '' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('builtin provider lookup', () => {
    it('should return 404 when builtin provider not found', async () => {
      vi.mocked(getBuiltinProvider).mockReturnValue(null as any);

      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinId: 'nonexistent' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Unknown builtin provider');
    });
  });

  describe('duplicate check', () => {
    it('should return 409 when provider already installed', async () => {
      vi.mocked(getProviderBySlug).mockResolvedValue({ id: 'existing' } as any);

      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinId: 'github' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('Provider already installed');
    });
  });

  describe('success path', () => {
    it('should install provider and return 201', async () => {
      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinId: 'github' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.provider).toMatchObject({
        id: 'provider_1',
        slug: 'github',
        name: 'GitHub',
      });
    });

    it('should pass correct parameters to createProvider', async () => {
      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinId: 'github' }),
      });
      await POST(request);

      expect(createProvider).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          slug: 'github',
          name: 'GitHub',
          providerType: 'builtin',
          isSystem: true,
          createdBy: 'admin_123',
          driveId: null,
          enabled: true,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 on createProvider error', async () => {
      vi.mocked(createProvider).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinId: 'github' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to install provider');
    });

    it('should log error on failure', async () => {
      const error = new Error('DB error');
      vi.mocked(createProvider).mockRejectedValue(error);

      const request = new Request('https://example.com/api/integrations/providers/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtinId: 'github' }),
      });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error installing builtin provider:',
        error
      );
    });
  });
});
