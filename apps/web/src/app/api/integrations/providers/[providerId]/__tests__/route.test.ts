/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/providers/[providerId]
//
// Tests GET, PUT, and DELETE route handlers for individual provider management.
// Next.js 15: params are Promises and must be awaited.
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
  getProviderById: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  countProviderConnections: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError, verifyAdminAuth } from '@/lib/auth';
import {
  getProviderById,
  updateProvider,
  deleteProvider,
  countProviderConnections,
} from '@pagespace/lib/integrations';
import { GET, PUT, DELETE } from '../route';

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

const createMockContext = (providerId: string) => ({
  params: Promise.resolve({ providerId }),
});

const mockProvider = {
  id: 'provider_1',
  slug: 'my-provider',
  name: 'My Provider',
  description: 'Test provider',
  iconUrl: null,
  documentationUrl: null,
  providerType: 'custom',
  config: { baseUrl: 'https://api.example.com' },
  isSystem: false,
  enabled: true,
  createdBy: 'user_123',
  driveId: null,
  createdAt: new Date('2024-01-01'),
};

describe('GET /api/integrations/providers/[providerId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getProviderById).mockResolvedValue(mockProvider as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/providers/provider_1');
      const response = await GET(request, createMockContext('provider_1'));

      expect(response.status).toBe(401);
    });
  });

  describe('provider lookup', () => {
    it('should return 404 when provider not found', async () => {
      vi.mocked(getProviderById).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/integrations/providers/nonexistent');
      const response = await GET(request, createMockContext('nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Provider not found');
    });

    it('should await params promise (Next.js 15 pattern)', async () => {
      const request = new Request('https://example.com/api/integrations/providers/provider_1');
      await GET(request, createMockContext('provider_1'));

      expect(getProviderById).toHaveBeenCalledWith(db, 'provider_1');
    });
  });

  describe('success path', () => {
    it('should return provider details', async () => {
      const request = new Request('https://example.com/api/integrations/providers/provider_1');
      const response = await GET(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.provider).toMatchObject({
        id: 'provider_1',
        slug: 'my-provider',
        name: 'My Provider',
      });
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(getProviderById).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/integrations/providers/provider_1');
      const response = await GET(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch provider');
    });
  });
});

describe('PUT /api/integrations/providers/[providerId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getProviderById).mockResolvedValue(mockProvider as any);
    vi.mocked(updateProvider).mockResolvedValue({ ...mockProvider, name: 'Updated' } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PUT(request, createMockContext('provider_1'));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when provider not found', async () => {
      vi.mocked(getProviderById).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PUT(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Provider not found');
    });

    it('should return 403 for system providers', async () => {
      vi.mocked(getProviderById).mockResolvedValue({ ...mockProvider, isSystem: true } as any);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PUT(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('System providers cannot be modified');
    });

    it('should return 403 when non-creator and non-admin tries to modify', async () => {
      vi.mocked(getProviderById).mockResolvedValue({
        ...mockProvider,
        createdBy: 'other_user',
      } as any);
      vi.mocked(verifyAdminAuth).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PUT(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Not authorized to modify this provider');
    });

    it('should allow admin to modify non-owned provider', async () => {
      vi.mocked(getProviderById).mockResolvedValue({
        ...mockProvider,
        createdBy: 'other_user',
      } as any);
      vi.mocked(verifyAdminAuth).mockResolvedValue({
        id: mockUserId,
        role: 'admin',
      } as any);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PUT(request, createMockContext('provider_1'));

      expect(response.status).toBe(200);
    });

    it('should allow creator to modify own provider', async () => {
      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PUT(request, createMockContext('provider_1'));

      expect(response.status).toBe(200);
      expect(verifyAdminAuth).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid update data', async () => {
      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }), // empty name is invalid
      });
      const response = await PUT(request, createMockContext('provider_1'));

      expect(response.status).toBe(400);
    });
  });

  describe('tool merging', () => {
    it('should merge addTools into existing config.tools', async () => {
      vi.mocked(getProviderById).mockResolvedValue({
        ...mockProvider,
        config: {
          tools: [{ id: 'existing-tool', name: 'Existing' }],
        },
      } as any);

      const newTool = {
        id: 'new-tool',
        name: 'New Tool',
        category: 'read',
        execution: {
          type: 'http',
          config: { method: 'GET', pathTemplate: '/api/test' },
        },
      };

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addTools: [newTool] }),
      });
      const response = await PUT(request, createMockContext('provider_1'));

      expect(response.status).toBe(200);
      expect(updateProvider).toHaveBeenCalledWith(
        db,
        'provider_1',
        expect.objectContaining({
          config: expect.objectContaining({
            tools: expect.arrayContaining([
              expect.objectContaining({ id: 'existing-tool' }),
              expect.objectContaining({ id: 'new-tool' }),
            ]),
          }),
        })
      );
    });
  });

  describe('success path', () => {
    it('should return updated provider', async () => {
      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Provider' }),
      });
      const response = await PUT(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.provider).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should return 500 on update error', async () => {
      vi.mocked(updateProvider).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await PUT(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update provider');
    });
  });
});

describe('DELETE /api/integrations/providers/[providerId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getProviderById).mockResolvedValue(mockProvider as any);
    vi.mocked(countProviderConnections).mockResolvedValue(0);
    vi.mocked(deleteProvider).mockResolvedValue(true as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createMockContext('provider_1'));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when provider not found', async () => {
      vi.mocked(getProviderById).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Provider not found');
    });

    it('should return 403 for system providers', async () => {
      vi.mocked(getProviderById).mockResolvedValue({ ...mockProvider, isSystem: true } as any);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('System providers cannot be deleted');
    });

    it('should return 403 when non-creator and non-admin tries to delete', async () => {
      vi.mocked(getProviderById).mockResolvedValue({
        ...mockProvider,
        createdBy: 'other_user',
      } as any);
      vi.mocked(verifyAdminAuth).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Not authorized to delete this provider');
    });
  });

  describe('connection check', () => {
    it('should return 409 when provider has active connections', async () => {
      vi.mocked(countProviderConnections).mockResolvedValue(3);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toContain('3 active connection(s)');
    });
  });

  describe('success path', () => {
    it('should delete provider and return success', async () => {
      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should return 500 when deleteProvider returns false', async () => {
      vi.mocked(deleteProvider).mockResolvedValue(false as any);

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete provider');
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(deleteProvider).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/integrations/providers/provider_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createMockContext('provider_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete provider');
    });
  });
});
