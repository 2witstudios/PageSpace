import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const orderByMock = vi.fn().mockResolvedValue([]);
  const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  return {
    db: {
      select: selectMock,
    },
    conversations: {},
    aiUsageLogs: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions, type: 'and' })),
    desc: vi.fn((field: unknown) => ({ field, type: 'desc' })),
  };
});

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/ai-monitoring', () => ({
  getContextWindow: vi.fn(() => 200000),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getContextWindow } from '@pagespace/lib/ai-monitoring';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock conversation
const mockConversation = (overrides: Partial<{
  id: string;
  userId: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id || 'conv_123',
  userId: overrides.userId || 'user_123',
  isActive: overrides.isActive ?? true,
});

// Helper to create mock usage log
const mockUsageLog = (overrides: Partial<{
  id: string;
  timestamp: Date;
  userId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  conversationId: string;
  messageId: string | null;
  pageId: string | null;
  driveId: string | null;
  success: boolean;
  error: string | null;
  contextSize: number;
  messageCount: number;
  wasTruncated: boolean;
}> = {}) => ({
  id: overrides.id || 'log_123',
  timestamp: overrides.timestamp || new Date(),
  userId: overrides.userId || 'user_123',
  provider: overrides.provider || 'openrouter',
  model: overrides.model || 'anthropic/claude-3-opus',
  inputTokens: overrides.inputTokens ?? 1000,
  outputTokens: overrides.outputTokens ?? 500,
  totalTokens: overrides.totalTokens ?? 1500,
  cost: overrides.cost ?? 0.015,
  conversationId: overrides.conversationId || 'conv_123',
  messageId: overrides.messageId ?? null,
  pageId: overrides.pageId ?? null,
  driveId: overrides.driveId ?? null,
  success: overrides.success ?? true,
  error: overrides.error ?? null,
  contextSize: overrides.contextSize ?? 50000,
  messageCount: overrides.messageCount ?? 10,
  wasTruncated: overrides.wasTruncated ?? false,
});

describe('GET /api/ai/global/[id]/usage', () => {
  const mockUserId = 'user_123';
  const mockConversationId = 'conv_123';

  let selectCallCount = 0;

  // Helper to setup select mocks for conversation and usage logs
  const setupSelectMocks = (
    conversation: ReturnType<typeof mockConversation> | undefined,
    usageLogs: ReturnType<typeof mockUsageLog>[]
  ) => {
    selectCallCount = 0;
    const orderByMock = vi.fn().mockImplementation(() => {
      return Promise.resolve(usageLogs);
    });
    const whereMock = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // First call is for conversation
        return Promise.resolve(conversation ? [conversation] : []);
      } else {
        // Second call is for usage logs (returns object with orderBy)
        return { orderBy: orderByMock };
      }
    });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  const createContext = (id: string) => ({
    params: Promise.resolve({ id }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default context window
    vi.mocked(getContextWindow).mockReturnValue(200000);

    // Default: conversation exists, no usage logs
    setupSelectMocks(mockConversation(), []);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      expect(response.status).toBe(401);
    });
  });

  describe('conversation not found', () => {
    it('should return 404 when conversation does not exist', async () => {
      setupSelectMocks(undefined, []);

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Conversation not found');
    });
  });

  describe('successful retrieval', () => {
    it('should return usage statistics for conversation', async () => {
      const usageLogs = [
        mockUsageLog({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.01 }),
        mockUsageLog({ inputTokens: 2000, outputTokens: 800, totalTokens: 2800, cost: 0.02 }),
      ];
      setupSelectMocks(mockConversation(), usageLogs);

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.logs).toBeDefined();
      expect(body.summary).toBeDefined();
      expect(body.summary.billing).toBeDefined();
      expect(body.summary.billing.totalInputTokens).toBe(3000);
      expect(body.summary.billing.totalOutputTokens).toBe(1300);
      expect(body.summary.billing.totalTokens).toBe(4300);
      expect(body.summary.billing.totalCost).toBe(0.03);
    });

    it('should return empty logs with zero totals when no usage', async () => {
      setupSelectMocks(mockConversation(), []);

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.logs).toEqual([]);
      expect(body.summary.billing.totalInputTokens).toBe(0);
      expect(body.summary.billing.totalOutputTokens).toBe(0);
      expect(body.summary.billing.totalTokens).toBe(0);
      expect(body.summary.billing.totalCost).toBe(0);
      expect(body.summary.context).toBeNull();
    });

    it('should return context metrics from most recent log', async () => {
      const usageLogs = [
        mockUsageLog({
          contextSize: 75000,
          messageCount: 15,
          wasTruncated: false,
          model: 'anthropic/claude-3-opus',
        }),
      ];
      setupSelectMocks(mockConversation(), usageLogs);

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.summary.context).toBeDefined();
      expect(body.summary.context.currentContextSize).toBe(75000);
      expect(body.summary.context.messagesInContext).toBe(15);
      expect(body.summary.context.wasTruncated).toBe(false);
      expect(body.summary.mostRecentModel).toBe('anthropic/claude-3-opus');
      expect(body.summary.mostRecentProvider).toBe('openrouter');
    });

    it('should calculate context usage percentage correctly', async () => {
      const usageLogs = [
        mockUsageLog({ contextSize: 100000 }),
      ];
      vi.mocked(getContextWindow).mockReturnValue(200000);
      setupSelectMocks(mockConversation(), usageLogs);

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(body.summary.context.contextUsagePercent).toBe(50);
      expect(body.summary.context.contextWindowSize).toBe(200000);
    });

    it('should handle null token values gracefully', async () => {
      const usageLogs = [
        mockUsageLog({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }),
      ];
      setupSelectMocks(mockConversation(), usageLogs);

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.summary.billing.totalInputTokens).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      const whereMock = vi.fn().mockRejectedValue(new Error('Database error'));
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch AI usage');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should round cost to 6 decimal places', async () => {
      const usageLogs = [
        mockUsageLog({ cost: 0.00000123456789 }),
        mockUsageLog({ cost: 0.00000987654321 }),
      ];
      setupSelectMocks(mockConversation(), usageLogs);

      const request = new Request(`https://example.com/api/ai/global/${mockConversationId}/usage`, {
        method: 'GET',
      });
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      // Total should be rounded to 6 decimal places
      expect(typeof body.summary.billing.totalCost).toBe('number');
    });
  });
});
