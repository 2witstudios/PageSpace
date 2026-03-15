/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/providers
//
// Tests the GET (list providers) and POST (create provider) route handlers.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  verifyAdminAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/integrations', () => ({
  listEnabledProviders: vi.fn(),
  createProvider: vi.fn(),
  seedBuiltinProviders: vi.fn(),
  builtinProviderList: [],
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError, verifyAdminAuth } from '@/lib/auth';
import { listEnabledProviders, createProvider, seedBuiltinProviders, builtinProviderList } from '@pagespace/lib/integrations';
import { GET, POST } from '../route';

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

describe('GET /api/integrations/providers', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(listEnabledProviders).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/providers');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('auto-seeding', () => {
    it('should auto-seed builtin providers when none are installed', async () => {
      // First call returns empty, second returns seeded
      vi.mocked(listEnabledProviders)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'p1',
            slug: 'github',
            name: 'GitHub',
            description: null,
            iconUrl: null,
            documentationUrl: null,
            providerType: 'builtin',
            isSystem: true,
            enabled: true,
            createdAt: new Date(),
            config: {},
          },
        ]);
      vi.mocked(seedBuiltinProviders).mockResolvedValue([{ slug: 'github' }] as any);

      // Override builtinProviderList to have items
      Object.defineProperty(
        await import('@pagespace/lib/integrations'),
        'builtinProviderList',
        { value: [{ id: 'github', name: 'GitHub' }], writable: true }
      );

      const request = new Request('https://example.com/api/integrations/providers');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should handle seed failures gracefully', async () => {
      vi.mocked(listEnabledProviders).mockResolvedValue([]);
      vi.mocked(seedBuiltinProviders).mockRejectedValue(new Error('Seed failed'));

      const request = new Request('https://example.com/api/integrations/providers');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('success path', () => {
    it('should return empty providers list', async () => {
      const request = new Request('https://example.com/api/integrations/providers');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.providers).toEqual([]);
    });

    it('should return providers with safe fields (no config)', async () => {
      vi.mocked(listEnabledProviders).mockResolvedValue([
        {
          id: 'p1',
          slug: 'github',
          name: 'GitHub',
          description: 'GitHub integration',
          iconUrl: 'https://example.com/icon.png',
          documentationUrl: 'https://docs.example.com',
          providerType: 'openapi',
          isSystem: false,
          enabled: true,
          createdAt: new Date('2024-01-01'),
          config: { apiKey: 'secret-should-not-appear' },
        },
      ] as any);

      const request = new Request('https://example.com/api/integrations/providers');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.providers).toHaveLength(1);
      expect(body.providers[0]).not.toHaveProperty('config');
      expect(body.providers[0]).toMatchObject({
        id: 'p1',
        slug: 'github',
        name: 'GitHub',
      });
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(listEnabledProviders).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/integrations/providers');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to list providers');
    });
  });
});

describe('POST /api/integrations/providers', () => {
  const mockUserId = 'admin_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(verifyAdminAuth).mockResolvedValue({
      id: mockUserId,
      role: 'admin',
      tokenVersion: 0,
      adminRoleVersion: 0,
      authTransport: 'cookie',
    } as any);
    vi.mocked(createProvider).mockResolvedValue({
      id: 'new_provider',
      slug: 'my-provider',
      name: 'My Provider',
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'test',
          name: 'Test',
          providerType: 'custom',
          config: {},
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 403 when not admin', async () => {
      vi.mocked(verifyAdminAuth).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/integrations/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'test',
          name: 'Test',
          providerType: 'custom',
          config: {},
        }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Admin access required');
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid slug format', async () => {
      const request = new Request('https://example.com/api/integrations/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'Invalid Slug!',
          name: 'Test',
          providerType: 'custom',
          config: {},
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for missing name', async () => {
      const request = new Request('https://example.com/api/integrations/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'test',
          providerType: 'custom',
          config: {},
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid providerType', async () => {
      const request = new Request('https://example.com/api/integrations/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'test',
          name: 'Test',
          providerType: 'invalid',
          config: {},
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('success path', () => {
    it('should create provider and return 201', async () => {
      const request = new Request('https://example.com/api/integrations/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'my-provider',
          name: 'My Provider',
          providerType: 'custom',
          config: { baseUrl: 'https://api.example.com' },
        }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.provider).toMatchObject({
        id: 'new_provider',
        slug: 'my-provider',
      });
    });

    it('should pass correct parameters to createProvider', async () => {
      const request = new Request('https://example.com/api/integrations/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'my-provider',
          name: 'My Provider',
          description: 'Test provider',
          providerType: 'openapi',
          config: { baseUrl: 'https://api.example.com' },
          driveId: 'drive_1',
        }),
      });
      await POST(request);

      expect(createProvider).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          slug: 'my-provider',
          name: 'My Provider',
          description: 'Test provider',
          providerType: 'openapi',
          isSystem: false,
          createdBy: mockUserId,
          driveId: 'drive_1',
          enabled: true,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 on createProvider error', async () => {
      vi.mocked(createProvider).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/integrations/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'test',
          name: 'Test',
          providerType: 'custom',
          config: {},
        }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create provider');
    });
  });
});
