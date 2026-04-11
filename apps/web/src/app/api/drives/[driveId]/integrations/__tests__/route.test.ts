import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/integrations
// ============================================================================

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations', () => ({
  listDriveConnections: vi.fn(),
  createConnection: vi.fn(),
  getProviderById: vi.fn(),
  findDriveConnection: vi.fn(),
  encryptCredentials: vi.fn(),
  buildOAuthAuthorizationUrl: vi.fn(),
  createSignedState: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: 'mock-db',
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/audit/route-audit', () => ({
  logAuditEvent: vi.fn(),
}));

import { GET, POST } from '../route';
import { loggers } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import {
  listDriveConnections,
  createConnection,
  getProviderById,
  findDriveConnection,
  encryptCredentials,
  buildOAuthAuthorizationUrl,
  createSignedState,
} from '@pagespace/lib/integrations';
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

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

const MOCK_USER_ID = 'user_123';
const MOCK_DRIVE_ID = 'drive_abc';

// ============================================================================
// GET /api/drives/[driveId]/integrations
// ============================================================================

describe('GET /api/drives/[driveId]/integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives/d/integrations');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not a member', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: false, isMember: false, role: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Access denied');
    });
  });

  describe('response contract', () => {
    it('should return connections list with safe fields', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      vi.mocked(listDriveConnections).mockResolvedValue([
        {
          id: 'conn-1',
          providerId: 'prov-1',
          name: 'My Connection',
          status: 'active',
          statusMessage: null,
          accountMetadata: null,
          baseUrlOverride: null,
          lastUsedAt: null,
          createdAt: new Date('2024-01-01'),
          driveId: MOCK_DRIVE_ID,
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
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-01'),
          },
        },
      ]);

      const request = new Request('https://example.com/api/drives/d/integrations');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connections).toHaveLength(1);
      expect(body.connections[0]).toMatchObject({
        id: 'conn-1',
        providerId: 'prov-1',
        name: 'My Connection',
        status: 'active',
      });
      expect(body.connections[0].provider).toMatchObject({
        id: 'prov-1',
        slug: 'github',
        name: 'GitHub',
        description: 'GitHub integration',
      });
      // Credentials should NOT appear in response
      expect(body.connections[0].credentials).toBeUndefined();
    });

    it('should handle connections with null provider', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      vi.mocked(listDriveConnections).mockResolvedValue([
        // @ts-expect-error - partial mock data
        {
          id: 'conn-2',
          providerId: 'prov-x',
          name: 'Orphan',
          status: 'error',
          statusMessage: 'provider removed',
          accountMetadata: null,
          baseUrlOverride: null,
          lastUsedAt: null,
          createdAt: new Date('2024-01-01'),
          driveId: MOCK_DRIVE_ID,
          credentials: {},
          connectedBy: MOCK_USER_ID,
          connectedAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
          provider: null,
        },
      ]);

      const request = new Request('https://example.com/api/drives/d/integrations');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.connections[0].provider).toBe(null);
    });
  });

  describe('error handling', () => {
    it('should return 500 and log when service throws', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      const error = new Error('DB failed');
      vi.mocked(listDriveConnections).mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/drives/d/integrations');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to list integrations');
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error listing drive integrations:',
        error
      );
    });
  });
});

// ============================================================================
// POST /api/drives/[driveId]/integrations
// ============================================================================

describe('POST /api/drives/[driveId]/integrations', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    // Reset env
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('authentication', () => {
    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'p', name: 'n' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not owner or admin', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER',
      });

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'p', name: 'n' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Admin access required');
    });

    it('should allow admin access', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN',
      });
      // @ts-expect-error - partial mock data
      vi.mocked(getProviderById).mockResolvedValue({
        id: 'prov-1', slug: 'test', name: 'Test', enabled: true, driveId: null,
        config: { authMethod: { type: 'api_key', config: {} }, baseUrl: 'http://test', tools: [] },
        createdAt: new Date(), updatedAt: new Date(),
      });
      vi.mocked(findDriveConnection).mockResolvedValue(null);
      vi.mocked(encryptCredentials).mockResolvedValue({ key: 'encrypted' });
      // @ts-expect-error - partial mock data
      vi.mocked(createConnection).mockResolvedValue({
        id: 'conn-new', providerId: 'prov-1', name: 'Test', status: 'active',
        createdAt: new Date(), driveId: MOCK_DRIVE_ID, credentials: {},
        connectedBy: MOCK_USER_ID, connectedAt: new Date(), updatedAt: new Date(),
        statusMessage: null, accountMetadata: null, baseUrlOverride: null, lastUsedAt: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-1', name: 'Test', credentials: { key: 'val' } }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(201);
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
    });

    it('should return 400 for invalid body', async () => {
      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: '', name: '' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
      expect(typeof body.details).toBe('object');
    });

    it('should return 400 for missing providerId', async () => {
      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ name: 'Valid Name' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(400);
    });
  });

  describe('provider validation', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
    });

    it('should return 404 when provider not found', async () => {
      vi.mocked(getProviderById).mockResolvedValue(null);

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'nonexistent', name: 'Test' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Provider not found or disabled');
    });

    it('should return 404 when provider is disabled', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(getProviderById).mockResolvedValue({
        id: 'prov-1', slug: 'test', name: 'Test', enabled: false, driveId: null,
        config: {}, createdAt: new Date(), updatedAt: new Date(),
      });

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-1', name: 'Test' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Provider not found or disabled');
    });

    it('should return 404 when provider belongs to different drive', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(getProviderById).mockResolvedValue({
        id: 'prov-1', slug: 'test', name: 'Test', enabled: true, driveId: 'other-drive',
        config: {}, createdAt: new Date(), updatedAt: new Date(),
      });

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-1', name: 'Test' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Provider not available for this drive');
    });

    it('should allow provider scoped to same drive', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(getProviderById).mockResolvedValue({
        id: 'prov-1', slug: 'test', name: 'Test', enabled: true, driveId: MOCK_DRIVE_ID,
        config: { authMethod: { type: 'api_key', config: {} }, baseUrl: 'http://test', tools: [] },
        createdAt: new Date(), updatedAt: new Date(),
      });
      vi.mocked(findDriveConnection).mockResolvedValue(null);
      vi.mocked(encryptCredentials).mockResolvedValue({ key: 'enc' });
      // @ts-expect-error - partial mock data
      vi.mocked(createConnection).mockResolvedValue({
        id: 'conn-1', providerId: 'prov-1', name: 'Test', status: 'active',
        createdAt: new Date(), driveId: MOCK_DRIVE_ID, credentials: {},
        connectedBy: MOCK_USER_ID, connectedAt: new Date(), updatedAt: new Date(),
        statusMessage: null, accountMetadata: null, baseUrlOverride: null, lastUsedAt: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-1', name: 'Test', credentials: { key: 'val' } }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(201);
    });

    it('should return 409 when connection already exists', async () => {
      // @ts-expect-error - partial mock data
      vi.mocked(getProviderById).mockResolvedValue({
        id: 'prov-1', slug: 'test', name: 'Test', enabled: true, driveId: null,
        config: {}, createdAt: new Date(), updatedAt: new Date(),
      });
      vi.mocked(findDriveConnection).mockResolvedValue({
        id: 'existing', providerId: 'prov-1', driveId: MOCK_DRIVE_ID,
      } as never);

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-1', name: 'Test' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('Connection already exists for this provider');
    });
  });

  describe('OAuth flow', () => {
    const oauthProvider = {
      id: 'prov-oauth', slug: 'github', name: 'GitHub', enabled: true, driveId: null,
      config: {
        authMethod: {
          type: 'oauth2' as const,
          config: {
            authorizationUrl: 'https://github.com/login/oauth/authorize',
            tokenUrl: 'https://github.com/login/oauth/access_token',
            scopes: ['repo'],
          },
        },
        baseUrl: 'https://api.github.com',
        tools: [],
      },
      createdAt: new Date(), updatedAt: new Date(),
    };

    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      vi.mocked(getProviderById).mockResolvedValue(oauthProvider as never);
      vi.mocked(findDriveConnection).mockResolvedValue(null);
    });

    it('should return 500 when OAUTH_STATE_SECRET is missing', async () => {
      delete process.env.OAUTH_STATE_SECRET;

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-oauth', name: 'GitHub' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('OAuth not configured');
    });

    it('should return 500 when OAuth client ID is missing', async () => {
      process.env.OAUTH_STATE_SECRET = 'test-secret';
      // No INTEGRATION_GITHUB_CLIENT_ID set

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-oauth', name: 'GitHub' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('OAuth not configured for this provider');
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Missing OAuth client ID for provider',
        expect.objectContaining({ slug: 'github' })
      );
    });

    it('should return OAuth URL when properly configured', async () => {
      process.env.OAUTH_STATE_SECRET = 'test-secret';
      process.env.INTEGRATION_GITHUB_CLIENT_ID = 'client-id-123';
      process.env.WEB_APP_URL = 'https://app.example.com';

      vi.mocked(createSignedState).mockReturnValue('signed-state-token');
      vi.mocked(buildOAuthAuthorizationUrl).mockReturnValue('https://github.com/login/oauth/authorize?state=signed-state-token');

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-oauth', name: 'GitHub' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.url).toBe('https://github.com/login/oauth/authorize?state=signed-state-token');
      expect(createSignedState).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: MOCK_USER_ID,
          providerId: 'prov-oauth',
          name: 'GitHub',
          driveId: MOCK_DRIVE_ID,
          returnUrl: `/drives/${MOCK_DRIVE_ID}/settings`,
        }),
        'test-secret'
      );
      expect(buildOAuthAuthorizationUrl).toHaveBeenCalledWith(
        oauthProvider.config.authMethod.config,
        expect.objectContaining({
          clientId: 'client-id-123',
          redirectUri: 'https://app.example.com/api/user/integrations/callback',
          state: 'signed-state-token',
        })
      );
    });

    it('should use returnUrl when provided', async () => {
      process.env.OAUTH_STATE_SECRET = 'test-secret';
      process.env.INTEGRATION_GITHUB_CLIENT_ID = 'client-id-123';

      vi.mocked(createSignedState).mockReturnValue('token');
      vi.mocked(buildOAuthAuthorizationUrl).mockReturnValue('https://github.com/auth');

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({
          providerId: 'prov-oauth',
          name: 'GitHub',
          returnUrl: '/custom/return',
        }),
      });
      await POST(request, createContext(MOCK_DRIVE_ID));

      expect(createSignedState).toHaveBeenCalledWith(
        expect.objectContaining({ returnUrl: '/custom/return' }),
        'test-secret'
      );
    });

    it('should fall back to NEXTAUTH_URL when WEB_APP_URL is not set', async () => {
      process.env.OAUTH_STATE_SECRET = 'test-secret';
      process.env.INTEGRATION_GITHUB_CLIENT_ID = 'client-id-123';
      delete process.env.WEB_APP_URL;
      process.env.NEXTAUTH_URL = 'https://nextauth.example.com';

      vi.mocked(createSignedState).mockReturnValue('token');
      vi.mocked(buildOAuthAuthorizationUrl).mockReturnValue('https://github.com/auth');

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-oauth', name: 'GitHub' }),
      });
      await POST(request, createContext(MOCK_DRIVE_ID));

      expect(buildOAuthAuthorizationUrl).toHaveBeenCalledWith(
        oauthProvider.config.authMethod.config,
        expect.objectContaining({
          redirectUri: 'https://nextauth.example.com/api/user/integrations/callback',
        })
      );
    });

    it('should fall back to localhost when no URL env vars set', async () => {
      process.env.OAUTH_STATE_SECRET = 'test-secret';
      process.env.INTEGRATION_GITHUB_CLIENT_ID = 'client-id-123';
      delete process.env.WEB_APP_URL;
      delete process.env.NEXTAUTH_URL;

      vi.mocked(createSignedState).mockReturnValue('token');
      vi.mocked(buildOAuthAuthorizationUrl).mockReturnValue('https://github.com/auth');

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-oauth', name: 'GitHub' }),
      });
      await POST(request, createContext(MOCK_DRIVE_ID));

      expect(buildOAuthAuthorizationUrl).toHaveBeenCalledWith(
        oauthProvider.config.authMethod.config,
        expect.objectContaining({
          redirectUri: 'http://localhost:3000/api/user/integrations/callback',
        })
      );
    });
  });

  describe('non-OAuth flow', () => {
    beforeEach(() => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      // @ts-expect-error - partial mock data
      vi.mocked(getProviderById).mockResolvedValue({
        id: 'prov-api', slug: 'linear', name: 'Linear', enabled: true, driveId: null,
        config: {
          authMethod: { type: 'api_key' as const, config: { placement: 'header', paramName: 'Authorization' } },
          baseUrl: 'https://api.linear.app',
          tools: [],
        },
        createdAt: new Date(), updatedAt: new Date(),
      });
      vi.mocked(findDriveConnection).mockResolvedValue(null);
    });

    it('should return 400 when credentials are missing', async () => {
      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-api', name: 'Linear' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Credentials are required');
    });

    it('should return 400 when credentials object is empty', async () => {
      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-api', name: 'Linear', credentials: {} }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Credentials are required');
    });

    it('should create connection with encrypted credentials', async () => {
      vi.mocked(encryptCredentials).mockResolvedValue({ apiKey: 'enc_xyz' });
      // @ts-expect-error - partial mock data
      vi.mocked(createConnection).mockResolvedValue({
        id: 'conn-new', providerId: 'prov-api', name: 'Linear', status: 'active',
        createdAt: new Date('2024-06-01'), driveId: MOCK_DRIVE_ID, credentials: {},
        connectedBy: MOCK_USER_ID, connectedAt: new Date(), updatedAt: new Date(),
        statusMessage: null, accountMetadata: null, baseUrlOverride: null, lastUsedAt: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({
          providerId: 'prov-api',
          name: 'Linear',
          credentials: { apiKey: 'lin_abc123' },
          baseUrlOverride: 'https://custom.linear.app',
        }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.connection).toMatchObject({
        id: 'conn-new',
        providerId: 'prov-api',
        name: 'Linear',
        status: 'active',
      });
      expect(encryptCredentials).toHaveBeenCalledWith({ apiKey: 'lin_abc123' });
      expect(createConnection).toHaveBeenCalledWith('mock-db', expect.objectContaining({
        providerId: 'prov-api',
        driveId: MOCK_DRIVE_ID,
        name: 'Linear',
        status: 'active',
        credentials: { apiKey: 'enc_xyz' },
        baseUrlOverride: 'https://custom.linear.app',
        connectedBy: MOCK_USER_ID,
      }));
    });

    it('should pass null baseUrlOverride when not provided', async () => {
      vi.mocked(encryptCredentials).mockResolvedValue({ key: 'enc' });
      // @ts-expect-error - partial mock data
      vi.mocked(createConnection).mockResolvedValue({
        id: 'conn-x', providerId: 'prov-api', name: 'Test', status: 'active',
        createdAt: new Date(), driveId: MOCK_DRIVE_ID, credentials: {},
        connectedBy: MOCK_USER_ID, connectedAt: new Date(), updatedAt: new Date(),
        statusMessage: null, accountMetadata: null, baseUrlOverride: null, lastUsedAt: null,
      });

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({
          providerId: 'prov-api',
          name: 'Test',
          credentials: { key: 'val' },
        }),
      });
      await POST(request, createContext(MOCK_DRIVE_ID));

      expect(createConnection).toHaveBeenCalledWith('mock-db', expect.objectContaining({
        baseUrlOverride: null,
      }));
    });
  });

  describe('error handling', () => {
    it('should return 500 and log when service throws', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true, isAdmin: true, isMember: true, role: 'OWNER',
      });
      const error = new Error('Unexpected error');
      vi.mocked(getProviderById).mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/drives/d/integrations', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'prov-1', name: 'Test' }),
      });
      const response = await POST(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create integration');
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error creating drive integration:',
        error
      );
    });
  });
});
