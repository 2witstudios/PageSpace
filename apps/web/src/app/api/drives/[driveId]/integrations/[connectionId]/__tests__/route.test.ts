import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/integrations/[connectionId]
// ============================================================================

vi.mock('@pagespace/lib/audit/audit-log', () => ({
    audit: vi.fn(),
    auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
    getConnectionById: vi.fn(),
    getConnectionWithProvider: vi.fn(),
    deleteConnection: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: 'mock-db',
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { GET, DELETE } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { getConnectionById, getConnectionWithProvider, deleteConnection } from '@pagespace/lib/integrations/repositories/connection-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string, connectionId: string) => ({
  params: Promise.resolve({ driveId, connectionId }),
});

const MOCK_USER_ID = 'user_123';
const MOCK_DRIVE_ID = 'drive_abc';
const MOCK_CONNECTION_ID = 'conn_xyz';

// ============================================================================
// GET /api/drives/[driveId]/integrations/[connectionId]
// ============================================================================

describe('GET /api/drives/[driveId]/integrations/[connectionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives/d/integrations/c');
      const response = await GET(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not a member', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: false, isMember: false, role: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations/c');
      const response = await GET(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Access denied');
    });
  });

  describe('connection lookup', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
    });

    it('should return 404 when connection not found', async () => {
      vi.mocked(getConnectionWithProvider).mockResolvedValue(null);

      const request = new Request('https://example.com/api/drives/d/integrations/c');
      const response = await GET(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Connection not found');
    });

    it('should return 404 when connection belongs to different drive', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(getConnectionWithProvider).mockResolvedValue({
        id: MOCK_CONNECTION_ID,
        driveId: 'different-drive',
        providerId: 'prov-1',
        name: 'Test',
        status: 'active',
        statusMessage: null,
        accountMetadata: null,
        baseUrlOverride: null,
        lastUsedAt: null,
        createdAt: new Date(),
        credentials: {},
        connectedBy: MOCK_USER_ID,
        connectedAt: new Date(),
        updatedAt: new Date(),
        provider: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations/c');
      const response = await GET(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Connection not found');
    });
  });

  describe('response contract', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
    });

    it('should return connection with provider details', async () => {
      vi.mocked(getConnectionWithProvider).mockResolvedValue({
        id: MOCK_CONNECTION_ID,
        driveId: MOCK_DRIVE_ID,
        providerId: 'prov-1',
        name: 'GitHub Conn',
        status: 'active',
        statusMessage: 'Connected',
        accountMetadata: { login: 'user' },
        baseUrlOverride: 'https://custom.github.com',
        lastUsedAt: new Date('2024-06-01'),
        createdAt: new Date('2024-01-01'),
        credentials: { secret: 'SHOULD_NOT_APPEAR' },
        connectedBy: MOCK_USER_ID,
        connectedAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        provider: {
          id: 'prov-1',
          slug: 'github',
          name: 'GitHub',
          description: 'GitHub integration',
          // @ts-expect-error - test mock with extra properties
          enabled: true,
          config: {},
          driveId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      const request = new Request('https://example.com/api/drives/d/integrations/c');
      const response = await GET(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connection).toMatchObject({
        id: MOCK_CONNECTION_ID,
        providerId: 'prov-1',
        name: 'GitHub Conn',
        status: 'active',
        statusMessage: 'Connected',
      });
      expect(body.connection.provider).toMatchObject({
        id: 'prov-1',
        slug: 'github',
        name: 'GitHub',
        description: 'GitHub integration',
      });
      // Credentials should NOT appear
      expect(body.connection.credentials).toBeUndefined();
    });

    it('should handle connection with null provider', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(getConnectionWithProvider).mockResolvedValue({
        id: MOCK_CONNECTION_ID,
        driveId: MOCK_DRIVE_ID,
        providerId: 'prov-1',
        name: 'Orphan',
        status: 'error',
        statusMessage: null,
        accountMetadata: null,
        baseUrlOverride: null,
        lastUsedAt: null,
        createdAt: new Date('2024-01-01'),
        credentials: {},
        connectedBy: MOCK_USER_ID,
        connectedAt: new Date(),
        updatedAt: new Date(),
        provider: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations/c');
      const response = await GET(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(body.connection.provider).toBe(null);
    });
  });

  describe('error handling', () => {
    it('should return 500 and log when service throws', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      const error = new Error('DB failed');
      vi.mocked(getConnectionWithProvider).mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/drives/d/integrations/c');
      const response = await GET(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch integration');
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error fetching drive integration:',
        error
      );
    });
  });
});

// ============================================================================
// DELETE /api/drives/[driveId]/integrations/[connectionId]
// ============================================================================

describe('DELETE /api/drives/[driveId]/integrations/[connectionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives/d/integrations/c', { method: 'DELETE' });
      const response = await DELETE(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER',
      });

      const request = new Request('https://example.com/api/drives/d/integrations/c', { method: 'DELETE' });
      const response = await DELETE(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Admin access required');
    });

    it('should allow owner to delete', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      // @ts-expect-error - partial mock data
      vi.mocked(getConnectionById).mockResolvedValue({
        id: MOCK_CONNECTION_ID, driveId: MOCK_DRIVE_ID, name: 'Test',
        providerId: 'p', status: 'active', credentials: {},
        connectedBy: MOCK_USER_ID, connectedAt: new Date(), updatedAt: new Date(),
        createdAt: new Date(), statusMessage: null, accountMetadata: null,
        baseUrlOverride: null, lastUsedAt: null,
      });
      vi.mocked(deleteConnection).mockResolvedValue(null);

      const request = new Request('https://example.com/api/drives/d/integrations/c', { method: 'DELETE' });
      const response = await DELETE(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));

      expect(response.status).toBe(200);
    });

    it('should allow admin to delete', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN',
      });
      // @ts-expect-error - partial mock data
      vi.mocked(getConnectionById).mockResolvedValue({
        id: MOCK_CONNECTION_ID, driveId: MOCK_DRIVE_ID, name: 'Test',
        providerId: 'p', status: 'active', credentials: {},
        connectedBy: MOCK_USER_ID, connectedAt: new Date(), updatedAt: new Date(),
        createdAt: new Date(), statusMessage: null, accountMetadata: null,
        baseUrlOverride: null, lastUsedAt: null,
      });
      vi.mocked(deleteConnection).mockResolvedValue(null);

      const request = new Request('https://example.com/api/drives/d/integrations/c', { method: 'DELETE' });
      const response = await DELETE(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));

      expect(response.status).toBe(200);
    });
  });

  describe('connection lookup', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
    });

    it('should return 404 when connection not found', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(null);

      const request = new Request('https://example.com/api/drives/d/integrations/c', { method: 'DELETE' });
      const response = await DELETE(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Connection not found');
    });

    it('should return 404 when connection belongs to different drive', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(getConnectionById).mockResolvedValue({
        id: MOCK_CONNECTION_ID, driveId: 'other-drive', name: 'Test',
        providerId: 'p', status: 'active', credentials: {},
        connectedBy: MOCK_USER_ID, connectedAt: new Date(), updatedAt: new Date(),
        createdAt: new Date(), statusMessage: null, accountMetadata: null,
        baseUrlOverride: null, lastUsedAt: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations/c', { method: 'DELETE' });
      const response = await DELETE(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Connection not found');
    });
  });

  describe('response contract', () => {
    it('should return success true and log deletion', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      // @ts-expect-error - partial mock data
      vi.mocked(getConnectionById).mockResolvedValue({
        id: MOCK_CONNECTION_ID, driveId: MOCK_DRIVE_ID, name: 'My Connection',
        providerId: 'p', status: 'active', credentials: {},
        connectedBy: MOCK_USER_ID, connectedAt: new Date(), updatedAt: new Date(),
        createdAt: new Date(), statusMessage: null, accountMetadata: null,
        baseUrlOverride: null, lastUsedAt: null,
      });
      vi.mocked(deleteConnection).mockResolvedValue(null);

      const request = new Request('https://example.com/api/drives/d/integrations/c', { method: 'DELETE' });
      const response = await DELETE(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(deleteConnection).toHaveBeenCalledWith('mock-db', MOCK_CONNECTION_ID);
      expect(loggers.api.info).toHaveBeenCalledWith(
        'Drive integration connection deleted',
        {
          connectionId: MOCK_CONNECTION_ID,
          driveId: MOCK_DRIVE_ID,
          connectionName: 'My Connection',
          deletedBy: MOCK_USER_ID,
        }
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 and log when service throws', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      const error = new Error('Delete failed');
      vi.mocked(getConnectionById).mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/drives/d/integrations/c', { method: 'DELETE' });
      const response = await DELETE(request, createContext(MOCK_DRIVE_ID, MOCK_CONNECTION_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete integration');
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error deleting drive integration:',
        error
      );
    });
  });
});
