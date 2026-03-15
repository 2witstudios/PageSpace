/**
 * Contract tests for GET /api/pages/[pageId]/ai-usage
 *
 * These tests verify the route handler's contract:
 * - Authentication and authorization checks
 * - Page existence validation
 * - AI usage log aggregation and summary statistics
 * - Context metrics calculation
 * - Error handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockAuthenticateRequest,
  mockIsAuthError,
  mockGetUserAccessLevel,
  mockGetContextWindow,
  mockDbSelect,
  mockLoggers,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
  mockGetUserAccessLevel: vi.fn(),
  mockGetContextWindow: vi.fn().mockReturnValue(200000),
  mockDbSelect: vi.fn(),
  mockLoggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

// ── vi.mock declarations ───────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
  pages: { id: 'id' },
  aiUsageLogs: {
    id: 'id',
    timestamp: 'timestamp',
    userId: 'userId',
    provider: 'provider',
    model: 'model',
    inputTokens: 'inputTokens',
    outputTokens: 'outputTokens',
    totalTokens: 'totalTokens',
    cost: 'cost',
    conversationId: 'conversationId',
    messageId: 'messageId',
    pageId: 'pageId',
    driveId: 'driveId',
    success: 'success',
    error: 'error',
    contextSize: 'contextSize',
    messageCount: 'messageCount',
    wasTruncated: 'wasTruncated',
  },
  eq: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserAccessLevel: (...args: unknown[]) => mockGetUserAccessLevel(...args),
  loggers: mockLoggers,
}));

vi.mock('@pagespace/lib/ai-monitoring', () => ({
  getContextWindow: (...args: unknown[]) => mockGetContextWindow(...args),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { GET } from '../../ai-usage/route';

// ── Helpers ────────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockPageId = 'page_123';

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

const createRequest = () =>
  new Request(`https://example.com/api/pages/${mockPageId}/ai-usage`, {
    method: 'GET',
  });

const mockParams = { params: Promise.resolve({ pageId: mockPageId }) };

const mockLogs = [
  {
    id: 'log_1',
    timestamp: new Date('2024-01-02'),
    userId: mockUserId,
    provider: 'anthropic',
    model: 'claude-3-opus',
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    cost: 0.045,
    conversationId: 'conv_1',
    messageId: 'msg_1',
    pageId: mockPageId,
    driveId: 'drive_1',
    success: true,
    error: null,
    contextSize: 5000,
    messageCount: 10,
    wasTruncated: false,
  },
  {
    id: 'log_2',
    timestamp: new Date('2024-01-01'),
    userId: mockUserId,
    provider: 'openai',
    model: 'gpt-4',
    inputTokens: 800,
    outputTokens: 400,
    totalTokens: 1200,
    cost: 0.03,
    conversationId: 'conv_1',
    messageId: 'msg_2',
    pageId: mockPageId,
    driveId: 'drive_1',
    success: true,
    error: null,
    contextSize: 3000,
    messageCount: 8,
    wasTruncated: true,
  },
];

/**
 * Helper to set up the chained select mock for page query + logs query
 */
function setupSelectChain(pageResult: unknown[], logResult: unknown[]) {
  let callCount = 0;
  mockDbSelect.mockImplementation(() => ({
    from: () => ({
      where: () => {
        callCount++;
        if (callCount === 1) {
          // pages query - returns array directly
          return Promise.resolve(pageResult);
        }
        // ai usage logs query - has orderBy
        return {
          orderBy: () => Promise.resolve(logResult),
        };
      },
    }),
  }));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/pages/[pageId]/ai-usage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth(mockUserId));
    mockIsAuthError.mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    mockGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canDelete: true,
      accessLevel: 'owner',
    });
    mockGetContextWindow.mockReturnValue(200000);
    setupSelectChain([{ id: mockPageId }], mockLogs);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), mockParams);

      expect(response.status).toBe(401);
    });
  });

  describe('page validation', () => {
    it('returns 404 when page is not found', async () => {
      setupSelectChain([], []);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user has no access level', async () => {
      mockGetUserAccessLevel.mockResolvedValue(null);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/access denied/i);
    });

    it('returns 403 when user cannot view the page', async () => {
      mockGetUserAccessLevel.mockResolvedValue({
        canView: false,
        canEdit: false,
        canDelete: false,
        accessLevel: 'none',
      });

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/access denied/i);
    });
  });

  describe('usage statistics', () => {
    it('returns logs and summary with aggregated billing metrics', async () => {
      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.logs).toHaveLength(2);
      expect(body.summary.billing.totalInputTokens).toBe(1800);
      expect(body.summary.billing.totalOutputTokens).toBe(900);
      expect(body.summary.billing.totalTokens).toBe(2700);
      expect(body.summary.billing.totalCost).toBe(0.075);
    });

    it('returns most recent model and provider from first log', async () => {
      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(body.summary.mostRecentModel).toBe('claude-3-opus');
      expect(body.summary.mostRecentProvider).toBe('anthropic');
    });

    it('returns context metrics from most recent log', async () => {
      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(body.summary.context).toBeDefined();
      expect(body.summary.context.currentContextSize).toBe(5000);
      expect(body.summary.context.messagesInContext).toBe(10);
      expect(body.summary.context.wasTruncated).toBe(false);
    });

    it('calculates context usage percentage correctly', async () => {
      mockGetContextWindow.mockReturnValue(200000);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      // 5000 / 200000 * 100 = 2.5, Math.round = 3
      expect(body.summary.context.contextUsagePercent).toBe(3);
    });
  });

  describe('empty logs', () => {
    it('returns zero statistics when no logs exist', async () => {
      setupSelectChain([{ id: mockPageId }], []);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.logs).toHaveLength(0);
      expect(body.summary.billing.totalInputTokens).toBe(0);
      expect(body.summary.billing.totalOutputTokens).toBe(0);
      expect(body.summary.billing.totalTokens).toBe(0);
      expect(body.summary.billing.totalCost).toBe(0);
      expect(body.summary.mostRecentModel).toBeNull();
      expect(body.summary.mostRecentProvider).toBeNull();
      expect(body.summary.context).toBeNull();
    });
  });

  describe('null token values', () => {
    it('handles null token values in logs gracefully', async () => {
      setupSelectChain([{ id: mockPageId }], [
        {
          id: 'log_1',
          timestamp: new Date(),
          userId: mockUserId,
          provider: 'anthropic',
          model: 'claude-3',
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          cost: null,
          conversationId: null,
          messageId: null,
          pageId: mockPageId,
          driveId: null,
          success: true,
          error: null,
          contextSize: null,
          messageCount: null,
          wasTruncated: null,
        },
      ]);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.summary.billing.totalInputTokens).toBe(0);
      expect(body.summary.billing.totalOutputTokens).toBe(0);
      expect(body.summary.billing.totalTokens).toBe(0);
      expect(body.summary.billing.totalCost).toBe(0);
      expect(body.summary.context.currentContextSize).toBe(0);
      expect(body.summary.context.contextUsagePercent).toBe(0);
      expect(body.summary.context.messagesInContext).toBe(0);
      expect(body.summary.context.wasTruncated).toBe(false);
    });
  });

  describe('context window calculation', () => {
    it('returns zero context usage percent when context size is zero', async () => {
      setupSelectChain([{ id: mockPageId }], [
        {
          ...mockLogs[0],
          contextSize: 0,
        },
      ]);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(body.summary.context.contextUsagePercent).toBe(0);
    });
  });

  describe('error handling', () => {
    it('returns 500 for unexpected errors', async () => {
      mockAuthenticateRequest.mockRejectedValue(new Error('Unexpected'));

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
