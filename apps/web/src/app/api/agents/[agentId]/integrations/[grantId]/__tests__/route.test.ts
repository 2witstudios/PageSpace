/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/agents/[agentId]/integrations/[grantId]
//
// Tests PUT (update grant) and DELETE (remove grant) handlers.
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

vi.mock('@pagespace/lib/integrations', () => ({
  getGrantById: vi.fn(),
  updateGrant: vi.fn(),
  deleteGrant: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions';
import { getGrantById, updateGrant, deleteGrant } from '@pagespace/lib/integrations';
import { PUT, DELETE } from '../route';

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

const createContext = (agentId = 'agent_1', grantId = 'grant_1') => ({
  params: Promise.resolve({ agentId, grantId }),
});

const createPutRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/agents/agent_1/integrations/grant_1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const createDeleteRequest = () =>
  new Request('https://example.com/api/agents/agent_1/integrations/grant_1', {
    method: 'DELETE',
  });

const mockGrant = (overrides: Record<string, unknown> = {}) => ({
  id: 'grant_1',
  agentId: 'agent_1',
  connectionId: 'conn_1',
  allowedTools: null,
  deniedTools: null,
  readOnly: false,
  rateLimitOverride: null,
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('PUT /api/agents/[agentId]/integrations/[grantId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(getGrantById).mockResolvedValue(mockGrant() as any);
    vi.mocked(updateGrant).mockResolvedValue({
      id: 'grant_1',
      readOnly: true,
      allowedTools: ['read_file'],
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await PUT(
        createPutRequest({ readOnly: true }),
        createContext()
      );

      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user cannot edit agent', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await PUT(
        createPutRequest({ readOnly: true }),
        createContext()
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Access denied');
    });
  });

  describe('grant lookup', () => {
    it('should return 404 when grant not found', async () => {
      vi.mocked(getGrantById).mockResolvedValue(null);

      const response = await PUT(
        createPutRequest({ readOnly: true }),
        createContext()
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Grant not found');
    });

    it('should return 404 when grant does not belong to agent', async () => {
      vi.mocked(getGrantById).mockResolvedValue(
        mockGrant({ agentId: 'other_agent' }) as any
      );

      const response = await PUT(
        createPutRequest({ readOnly: true }),
        createContext()
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('Grant not found');
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid allowedTools type', async () => {
      const response = await PUT(
        createPutRequest({ allowedTools: 'not_an_array' }),
        createContext()
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 for out-of-range rate limit', async () => {
      const response = await PUT(
        createPutRequest({ rateLimitOverride: { requestsPerMinute: 0 } }),
        createContext()
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Validation failed');
    });
  });

  describe('success path', () => {
    it('should update grant and return result', async () => {
      const response = await PUT(
        createPutRequest({ readOnly: true, allowedTools: ['read_file'] }),
        createContext()
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.grant.readOnly).toBe(true);
      expect(updateGrant).toHaveBeenCalledWith(
        expect.anything(),
        'grant_1',
        expect.objectContaining({ readOnly: true, allowedTools: ['read_file'] })
      );
    });

    it('should allow updating deniedTools', async () => {
      await PUT(
        createPutRequest({ deniedTools: ['delete_repo'] }),
        createContext()
      );

      expect(updateGrant).toHaveBeenCalledWith(
        expect.anything(),
        'grant_1',
        expect.objectContaining({ deniedTools: ['delete_repo'] })
      );
    });

    it('should allow setting nullable fields to null', async () => {
      await PUT(
        createPutRequest({ allowedTools: null, rateLimitOverride: null }),
        createContext()
      );

      expect(updateGrant).toHaveBeenCalledWith(
        expect.anything(),
        'grant_1',
        expect.objectContaining({ allowedTools: null, rateLimitOverride: null })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(updateGrant).mockRejectedValue(new Error('DB error'));

      const response = await PUT(
        createPutRequest({ readOnly: true }),
        createContext()
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to update grant');
    });
  });
});

describe('DELETE /api/agents/[agentId]/integrations/[grantId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    vi.mocked(getGrantById).mockResolvedValue(mockGrant() as any);
    vi.mocked(deleteGrant).mockResolvedValue(undefined as any);
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
    it('should return 403 when user cannot edit agent', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(403);
    });
  });

  describe('grant lookup', () => {
    it('should return 404 when grant not found', async () => {
      vi.mocked(getGrantById).mockResolvedValue(null);

      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(404);
    });

    it('should return 404 when grant belongs to different agent', async () => {
      vi.mocked(getGrantById).mockResolvedValue(
        mockGrant({ agentId: 'other_agent' }) as any
      );

      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(404);
    });
  });

  describe('success path', () => {
    it('should delete grant and return success', async () => {
      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(deleteGrant).toHaveBeenCalledWith(expect.anything(), 'grant_1');
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(deleteGrant).mockRejectedValue(new Error('Cascade error'));

      const response = await DELETE(createDeleteRequest(), createContext());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to delete grant');
    });
  });
});
