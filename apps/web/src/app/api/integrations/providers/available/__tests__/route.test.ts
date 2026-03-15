/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/providers/available
//
// Tests the route handler for listing builtin providers not yet installed.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/integrations', () => ({
  builtinProviderList: [
    { id: 'github', name: 'GitHub', description: 'GitHub integration', documentationUrl: 'https://docs.github.com' },
    { id: 'slack', name: 'Slack', description: 'Slack integration' },
    { id: 'jira', name: 'Jira', description: 'Jira integration' },
  ],
  listEnabledProviders: vi.fn(),
}));

import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { listEnabledProviders } from '@pagespace/lib/integrations';
import { GET } from '../route';

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

describe('GET /api/integrations/providers/available', () => {
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

      const request = new Request('https://example.com/api/integrations/providers/available');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('success path', () => {
    it('should return all builtins when none are installed', async () => {
      vi.mocked(listEnabledProviders).mockResolvedValue([]);

      const request = new Request('https://example.com/api/integrations/providers/available');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.providers).toHaveLength(3);
      expect(body.providers[0]).toMatchObject({
        id: 'github',
        name: 'GitHub',
        description: 'GitHub integration',
        documentationUrl: 'https://docs.github.com',
      });
    });

    it('should exclude already installed providers', async () => {
      vi.mocked(listEnabledProviders).mockResolvedValue([
        { slug: 'github', id: 'p1', name: 'GitHub' },
      ] as any);

      const request = new Request('https://example.com/api/integrations/providers/available');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.providers).toHaveLength(2);
      expect(body.providers.find((p: any) => p.id === 'github')).toBeUndefined();
    });

    it('should return empty list when all are installed', async () => {
      vi.mocked(listEnabledProviders).mockResolvedValue([
        { slug: 'github' },
        { slug: 'slack' },
        { slug: 'jira' },
      ] as any);

      const request = new Request('https://example.com/api/integrations/providers/available');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.providers).toHaveLength(0);
    });

    it('should return null for missing optional fields', async () => {
      vi.mocked(listEnabledProviders).mockResolvedValue([
        { slug: 'github' },
        { slug: 'jira' },
      ] as any);

      const request = new Request('https://example.com/api/integrations/providers/available');
      const response = await GET(request);
      const body = await response.json();

      // Slack has no documentationUrl
      const slack = body.providers.find((p: any) => p.id === 'slack');
      expect(slack).toBeDefined();
      expect(slack.documentationUrl).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return 500 on database error', async () => {
      vi.mocked(listEnabledProviders).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/integrations/providers/available');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to list available providers');
    });

    it('should log error on failure', async () => {
      const error = new Error('DB error');
      vi.mocked(listEnabledProviders).mockRejectedValue(error);

      const request = new Request('https://example.com/api/integrations/providers/available');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error listing available builtins:',
        error
      );
    });
  });
});
