/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/user/integrations
//
// Tests GET (list connections) and POST (create connection) handlers.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/integrations', () => ({
  listUserConnections: vi.fn(),
  createConnection: vi.fn(),
  getProviderById: vi.fn(),
  findUserConnection: vi.fn(),
  encryptCredentials: vi.fn(),
  buildOAuthAuthorizationUrl: vi.fn(),
  createSignedState: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  listUserConnections,
  createConnection,
  getProviderById,
  findUserConnection,
  encryptCredentials,
  buildOAuthAuthorizationUrl,
  createSignedState,
} from '@pagespace/lib/integrations';
import { GET, POST } from '../route';

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

const createGetRequest = () =>
  new Request('https://example.com/api/user/integrations');

const createPostRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/user/integrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockConnectionRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'conn_1',
  providerId: 'provider_1',
  name: 'My Integration',
  status: 'active',
  statusMessage: null,
  visibility: 'owned_drives',
  accountMetadata: null,
  baseUrlOverride: null,
  lastUsedAt: null,
  createdAt: new Date('2024-01-01'),
  credentials: 'encrypted_secret',
  provider: {
    id: 'provider_1',
    slug: 'github',
    name: 'GitHub',
    description: 'GitHub integration',
  },
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/user/integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(listUserConnections).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createGetRequest());

      expect(response.status).toBe(401);
    });
  });

  describe('success path', () => {
    it('should return empty connections array', async () => {
      const response = await GET(createGetRequest());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.connections).toEqual([]);
    });

    it('should return connections with credentials stripped', async () => {
      vi.mocked(listUserConnections).mockResolvedValue([
        mockConnectionRecord() as any,
      ]);

      const response = await GET(createGetRequest());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.connections).toHaveLength(1);
      expect(body.connections[0].id).toBe('conn_1');
      expect(body.connections[0].name).toBe('My Integration');
      expect(body.connections[0]).not.toHaveProperty('credentials');
      expect(body.connections[0].provider.slug).toBe('github');
    });

    it('should handle connections without provider', async () => {
      vi.mocked(listUserConnections).mockResolvedValue([
        mockConnectionRecord({ provider: null }) as any,
      ]);

      const response = await GET(createGetRequest());
      const body = await response.json();

      expect(body.connections[0].provider).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(listUserConnections).mockRejectedValue(new Error('DB error'));

      const response = await GET(createGetRequest());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to list integrations');
    });
  });
});

describe('POST /api/user/integrations', () => {
  const env = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    process.env = { ...env };
  });

  afterAll(() => {
    process.env = env;
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'Test' })
      );

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when providerId is missing', async () => {
      const response = await POST(createPostRequest({ name: 'Test' }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 when name is missing', async () => {
      const response = await POST(createPostRequest({ providerId: 'p1' }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Validation failed');
    });
  });

  describe('provider validation', () => {
    it('should return 404 when provider not found', async () => {
      vi.mocked(getProviderById).mockResolvedValue(null);

      const response = await POST(
        createPostRequest({ providerId: 'missing', name: 'Test' })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Provider not found or disabled');
    });

    it('should return 404 when provider is disabled', async () => {
      vi.mocked(getProviderById).mockResolvedValue({ enabled: false } as any);

      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'Test' })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Provider not found or disabled');
    });

    it('should return 409 when connection already exists', async () => {
      vi.mocked(getProviderById).mockResolvedValue({
        enabled: true,
        config: { authMethod: { type: 'api_key' } },
      } as any);
      vi.mocked(findUserConnection).mockResolvedValue({ id: 'existing' } as any);

      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'Test', credentials: { key: 'val' } })
      );

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe('Connection already exists for this provider');
    });
  });

  describe('OAuth flow', () => {
    beforeEach(() => {
      vi.mocked(getProviderById).mockResolvedValue({
        slug: 'github',
        enabled: true,
        config: {
          authMethod: {
            type: 'oauth2',
            config: { authorizationUrl: 'https://github.com/login/oauth/authorize', scopes: [] },
          },
        },
      } as any);
      vi.mocked(findUserConnection).mockResolvedValue(null);
      vi.mocked(createSignedState).mockReturnValue('signed-state-abc');
      vi.mocked(buildOAuthAuthorizationUrl).mockReturnValue('https://github.com/login/oauth/authorize?state=signed-state-abc');
    });

    it('should return 500 when OAUTH_STATE_SECRET is missing', async () => {
      delete process.env.OAUTH_STATE_SECRET;

      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'GitHub' })
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('OAuth not configured');
    });

    it('should return 500 when client ID is not configured', async () => {
      process.env.OAUTH_STATE_SECRET = 'secret';
      // No INTEGRATION_GITHUB_CLIENT_ID set

      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'GitHub' })
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('OAuth not configured for this provider');
    });

    it('should return OAuth URL on success', async () => {
      process.env.OAUTH_STATE_SECRET = 'secret';
      process.env.INTEGRATION_GITHUB_CLIENT_ID = 'client-id-123';

      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'GitHub' })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.url).toBe('https://github.com/login/oauth/authorize?state=signed-state-abc');
    });
  });

  describe('API key / non-OAuth flow', () => {
    beforeEach(() => {
      vi.mocked(getProviderById).mockResolvedValue({
        slug: 'slack',
        enabled: true,
        config: {
          authMethod: { type: 'api_key' },
        },
      } as any);
      vi.mocked(findUserConnection).mockResolvedValue(null);
      vi.mocked(encryptCredentials).mockResolvedValue('encrypted_creds');
      vi.mocked(createConnection).mockResolvedValue({
        id: 'conn_new',
        providerId: 'p1',
        name: 'Slack Bot',
        status: 'active',
        visibility: 'owned_drives',
        createdAt: new Date('2024-01-01'),
      } as any);
    });

    it('should return 400 when credentials are missing', async () => {
      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'Slack' })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Credentials are required for this provider type');
    });

    it('should return 400 when credentials are empty', async () => {
      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'Slack', credentials: {} })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Credentials are required for this provider type');
    });

    it('should create connection with encrypted credentials', async () => {
      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'Slack Bot', credentials: { token: 'xoxb-123' } })
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.connection.id).toBe('conn_new');
      expect(body.connection.name).toBe('Slack Bot');
      expect(encryptCredentials).toHaveBeenCalledWith({ token: 'xoxb-123' });
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(getProviderById).mockRejectedValue(new Error('Boom'));

      const response = await POST(
        createPostRequest({ providerId: 'p1', name: 'Test', credentials: { k: 'v' } })
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to create integration');
    });
  });
});
