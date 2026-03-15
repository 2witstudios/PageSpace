/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/providers/import-openapi
//
// Tests the route handler for importing OpenAPI specs. Admin only.
// ============================================================================

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
  importOpenAPISpec: vi.fn(),
}));

import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError, verifyAdminAuth } from '@/lib/auth';
import { importOpenAPISpec } from '@pagespace/lib/integrations';
import { POST } from '../route';

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

describe('POST /api/integrations/providers/import-openapi', () => {
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
    vi.mocked(importOpenAPISpec).mockResolvedValue({
      name: 'Petstore',
      tools: [],
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: '{}' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return admin error when not admin', async () => {
      vi.mocked(verifyAdminAuth).mockResolvedValue(
        NextResponse.json({ error: 'Admin required' }, { status: 403 }) as any
      );

      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: '{}' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(403);
    });
  });

  describe('validation', () => {
    it('should return 400 when spec is missing', async () => {
      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 when spec is empty', async () => {
      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: '' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid baseUrlOverride', async () => {
      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: '{}', baseUrlOverride: 'not-a-url' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('success path', () => {
    it('should return import result', async () => {
      const mockResult = {
        name: 'Petstore API',
        tools: [
          { id: 'listPets', name: 'List Pets', method: 'GET', path: '/pets' },
        ],
      };
      vi.mocked(importOpenAPISpec).mockResolvedValue(mockResult as any);

      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: '{"openapi":"3.0.0"}' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.result).toEqual(mockResult);
    });

    it('should pass selectedOperations and baseUrlOverride to importOpenAPISpec', async () => {
      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spec: '{"openapi":"3.0.0"}',
          selectedOperations: ['listPets', 'createPet'],
          baseUrlOverride: 'https://api.example.com',
        }),
      });
      await POST(request);

      expect(importOpenAPISpec).toHaveBeenCalledWith('{"openapi":"3.0.0"}', {
        selectedOperations: ['listPets', 'createPet'],
        baseUrlOverride: 'https://api.example.com',
      });
    });
  });

  describe('error handling', () => {
    it('should return 500 with error message on import failure', async () => {
      vi.mocked(importOpenAPISpec).mockRejectedValue(new Error('Invalid OpenAPI spec'));

      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: 'invalid' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Invalid OpenAPI spec');
    });

    it('should return generic message for non-Error exceptions', async () => {
      vi.mocked(importOpenAPISpec).mockRejectedValue('string error');

      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: 'invalid' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to import OpenAPI spec');
    });

    it('should log error on failure', async () => {
      const error = new Error('Import failed');
      vi.mocked(importOpenAPISpec).mockRejectedValue(error);

      const request = new Request('https://example.com/api/integrations/providers/import-openapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: 'invalid' }),
      });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error importing OpenAPI spec:',
        error
      );
    });
  });
});
