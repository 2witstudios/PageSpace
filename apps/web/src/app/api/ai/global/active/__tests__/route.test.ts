/**
 * Contract tests for GET /api/ai/global/active
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    getActiveGlobalConversation: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock logging (boundary)
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';

// Test fixtures
const mockUserId = 'user_123';

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

const mockConversationSummary = (overrides: Partial<{
  id: string;
  title: string | null;
  type: string;
  contextId: string | null;
  lastMessageAt: Date;
  createdAt: Date;
}> = {}) => ({
  id: overrides.id ?? 'conv_123',
  title: overrides.title ?? 'Test Conversation',
  type: overrides.type ?? 'global',
  contextId: overrides.contextId ?? null,
  lastMessageAt: overrides.lastMessageAt ?? new Date(),
  createdAt: overrides.createdAt ?? new Date(),
});

const createRequest = () =>
  new Request('https://example.com/api/ai/global/active', { method: 'GET' });

describe('GET /api/ai/global/active', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: no active conversation
    vi.mocked(globalConversationRepository.getActiveGlobalConversation).mockResolvedValue(null);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createRequest();

      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('successful retrieval', () => {
    it('should return the most recent global conversation', async () => {
      const conversation = mockConversationSummary({
        id: 'conv_active',
        title: 'Active Conversation',
        type: 'global',
      });
      vi.mocked(globalConversationRepository.getActiveGlobalConversation).mockResolvedValue(conversation);

      const request = createRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe('conv_active');
      expect(body.title).toBe('Active Conversation');
      expect(body.type).toBe('global');
    });

    it('should return null when no global conversation exists', async () => {
      vi.mocked(globalConversationRepository.getActiveGlobalConversation).mockResolvedValue(null);

      const request = createRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toBeNull();
    });

    it('should call repository with userId', async () => {
      const request = createRequest();

      await GET(request);

      expect(globalConversationRepository.getActiveGlobalConversation).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.getActiveGlobalConversation).mockRejectedValue(
        new Error('Database error')
      );

      const request = createRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch global conversation');
      const errorArg = vi.mocked(loggers.api.error).mock.calls[0];
      expect(errorArg[0]).toBe('Error fetching global conversation:');
      expect(errorArg[1]).toBeInstanceOf(Error);
      expect((errorArg[1] as Error).message).toBe('Database error');
    });
  });
});
