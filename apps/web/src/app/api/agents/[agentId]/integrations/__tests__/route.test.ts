/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/agents/[agentId]/integrations
//
// Tests GET (list grants) and POST (create grant) handlers.
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

vi.mock('@pagespace/lib/permissions', () => ({
  canUserEditPage: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/integrations', () => ({
  listGrantsByAgent: vi.fn(),
  createGrant: vi.fn(),
  getConnectionById: vi.fn(),
  findGrant: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import {
  listGrantsByAgent,
  createGrant,
  getConnectionById,
  findGrant,
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

const createContext = (agentId = 'agent_1') => ({
  params: Promise.resolve({ agentId }),
});

const createGetRequest = () =>
  new Request('https://example.com/api/agents/agent_1/integrations');

const createPostRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/agents/agent_1/integrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockGrantRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'grant_1',
  agentId: 'agent_1',
  connectionId: 'conn_1',
  allowedTools: null,
  deniedTools: null,
  readOnly: false,
  rateLimitOverride: null,
  createdAt: new Date('2024-01-01'),
  connection: {
    id: 'conn_1',
    name: 'My Connection',
    status: 'active',
    provider: {
      slug: 'github',
      name: 'GitHub',
    },
  },
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/agents/[agentId]/integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(listGrantsByAgent).mockResolvedValue([]);
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
    it('should return 403 when user cannot edit agent', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });
  });

  describe('success path', () => {
    it('should return empty grants array', async () => {
      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.grants).toEqual([]);
    });

    it('should return grants with connection info', async () => {
      vi.mocked(listGrantsByAgent).mockResolvedValue([mockGrantRecord() as any]);

      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.grants).toHaveLength(1);
      expect(body.grants[0].id).toBe('grant_1');
      expect(body.grants[0].connection.name).toBe('My Connection');
      expect(body.grants[0].connection.provider.slug).toBe('github');
    });

    it('should handle grants with null connection', async () => {
      vi.mocked(listGrantsByAgent).mockResolvedValue([
        mockGrantRecord({ connection: null }) as any,
      ]);

      const response = await GET(createGetRequest(), createContext());
      const body = await response.json();

      expect(body.grants[0].connection).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(listGrantsByAgent).mockRejectedValue(new Error('DB error'));

      const response = await GET(createGetRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to list grants');
    });
  });
});

describe('POST /api/agents/[agentId]/integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(getConnectionById).mockResolvedValue({
      id: 'conn_1',
      userId: 'user_1',
      driveId: null,
      status: 'active',
    } as any);
    vi.mocked(findGrant).mockResolvedValue(null);
    vi.mocked(createGrant).mockResolvedValue({
      id: 'grant_new',
      agentId: 'agent_1',
      connectionId: 'conn_1',
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user cannot edit agent', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });
  });

  describe('validation', () => {
    it('should return 400 when connectionId is missing', async () => {
      const response = await POST(
        createPostRequest({}),
        createContext()
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Validation failed');
    });
  });

  describe('connection validation', () => {
    it('should return 404 when connection not found', async () => {
      vi.mocked(getConnectionById).mockResolvedValue(null);

      const response = await POST(
        createPostRequest({ connectionId: 'missing' }),
        createContext()
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Connection not found');
    });

    it('should return 400 when connection is not active', async () => {
      vi.mocked(getConnectionById).mockResolvedValue({
        id: 'conn_1',
        userId: 'user_1',
        status: 'error',
      } as any);

      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Connection is not active');
    });

    it('should return 403 when user does not own user-scoped connection', async () => {
      vi.mocked(getConnectionById).mockResolvedValue({
        id: 'conn_1',
        userId: 'other_user',
        driveId: null,
        status: 'active',
      } as any);

      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });

    it('should allow drive member to create grant for drive-scoped connection', async () => {
      vi.mocked(getConnectionById).mockResolvedValue({
        id: 'conn_1',
        userId: null,
        driveId: 'drive_1',
        status: 'active',
      } as any);
      vi.mocked(getDriveAccess).mockResolvedValue({ isMember: true } as any);

      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(201);
    });

    it('should return 403 when user is not drive member for drive-scoped connection', async () => {
      vi.mocked(getConnectionById).mockResolvedValue({
        id: 'conn_1',
        userId: null,
        driveId: 'drive_1',
        status: 'active',
      } as any);
      vi.mocked(getDriveAccess).mockResolvedValue({ isMember: false } as any);

      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(403);
    });

    it('should return 409 when grant already exists', async () => {
      vi.mocked(findGrant).mockResolvedValue({ id: 'existing' } as any);

      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe('Grant already exists for this connection');
    });
  });

  describe('success path', () => {
    it('should create grant and return 201', async () => {
      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.grant.id).toBe('grant_new');
      expect(createGrant).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          agentId: 'agent_1',
          connectionId: 'conn_1',
        })
      );
    });

    it('should pass allowedTools and readOnly to createGrant', async () => {
      const response = await POST(
        createPostRequest({
          connectionId: 'conn_1',
          allowedTools: ['read_file', 'list_repos'],
          readOnly: true,
        }),
        createContext()
      );

      expect(response.status).toBe(201);
      expect(createGrant).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          allowedTools: ['read_file', 'list_repos'],
          readOnly: true,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(createGrant).mockRejectedValue(new Error('DB crash'));

      const response = await POST(
        createPostRequest({ connectionId: 'conn_1' }),
        createContext()
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to create grant');
    });
  });
});
