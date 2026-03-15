/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/user/integrations/[connectionId]
//
// Tests GET, PATCH, and DELETE handlers for a specific user connection.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    update: vi.fn(),
  },
  integrationConnections: { id: 'id' },
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/integrations', () => ({
  getConnectionById: vi.fn(),
  deleteConnection: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { getConnectionById, deleteConnection } from '@pagespace/lib/integrations';
import { GET, PATCH, DELETE } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (connectionId = 'conn_1') => ({
  params: Promise.resolve({ connectionId }),
});

const createGetRequest = () =>
  new Request('https://example.com/api/user/integrations/conn_1');

const createPatchRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/user/integrations/conn_1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const createDeleteRequest = () =>
  new Request('https://example.com/api/user/integrations/conn_1', {
    method: 'DELETE',
  });

const mockConnection = (overrides: Record<string, unknown> = {}) => ({
  id: 'conn_1',
  userId: 'user_1',
  providerId: 'provider_1',
  name: 'My Connection',
  status: 'active',
  statusMessage: null,
  visibility: 'owned_drives',
  accountMetadata: null,
  baseUrlOverride: null,
  configOverrides: null,
  lastUsedAt: null,
  createdAt: new Date('2024-01-01'),
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/user/integrations/[connectionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getConnectionById).mockResolvedValue(mockConnection() as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when connection not found', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(null);

      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Connection not found');
    });

    it('should return 404 when connection belongs to another user', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(
        mockConnection({ userId: 'other_user' }) as any
      );

      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Connection not found');
    });
  });

  describe('success path', () => {
    it('should return connection details without credentials', async () => {
      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.connection.id).toBe('conn_1');
      expect(body.connection.name).toBe('My Connection');
      expect(body.connection).not.toHaveProperty('credentials');
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(getConnectionById).mockRejectedValue(new Error('DB error'));

      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to fetch integration');
    });
  });
});

describe('PATCH /api/user/integrations/[connectionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getConnectionById).mockResolvedValue(mockConnection() as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'conn_1',
            name: 'Updated Name',
            visibility: 'private',
            configOverrides: null,
          }]),
        }),
      }),
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await PATCH(
        createPatchRequest({ name: 'Updated' }),
        createContext()
      );

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when connection not found', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(null);

      const response = await PATCH(
        createPatchRequest({ name: 'Updated' }),
        createContext()
      );

      expect(response.status).toBe(404);
    });

    it('should return 404 when connection belongs to another user', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(
        mockConnection({ userId: 'other_user' }) as any
      );

      const response = await PATCH(
        createPatchRequest({ name: 'Updated' }),
        createContext()
      );

      expect(response.status).toBe(404);
    });
  });

  describe('validation', () => {
    it('should return 400 when no fields to update', async () => {
      const response = await PATCH(
        createPatchRequest({}),
        createContext()
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('No fields to update');
    });

    it('should return 400 for invalid name (too long)', async () => {
      const response = await PATCH(
        createPatchRequest({ name: 'a'.repeat(101) }),
        createContext()
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Validation failed');
    });
  });

  describe('success path', () => {
    it('should update connection name', async () => {
      const response = await PATCH(
        createPatchRequest({ name: 'Updated Name' }),
        createContext()
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.connection.name).toBe('Updated Name');
    });

    it('should update connection visibility', async () => {
      const response = await PATCH(
        createPatchRequest({ visibility: 'private' }),
        createContext()
      );

      expect(response.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('should return 404 when update returns no rows', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const response = await PATCH(
        createPatchRequest({ name: 'Updated' }),
        createContext()
      );

      expect(response.status).toBe(404);
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(getConnectionById).mockRejectedValue(new Error('Crash'));

      const response = await PATCH(
        createPatchRequest({ name: 'Updated' }),
        createContext()
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to update integration');
    });
  });
});

describe('DELETE /api/user/integrations/[connectionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getConnectionById).mockResolvedValue(mockConnection() as any);
    vi.mocked(deleteConnection).mockResolvedValue(undefined as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 404 when connection not found', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(null);

      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(404);
    });

    it('should return 404 when connection belongs to another user', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(
        mockConnection({ userId: 'other_user' }) as any
      );

      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(404);
    });
  });

  describe('success path', () => {
    it('should delete connection and return success', async () => {
      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(deleteConnection).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(deleteConnection).mockRejectedValue(new Error('Cascade error'));

      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to delete integration');
    });
  });
});
