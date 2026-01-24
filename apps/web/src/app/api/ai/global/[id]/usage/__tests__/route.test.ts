/**
 * Contract tests for GET /api/ai/global/[id]/usage
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 * The pure function calculateUsageSummary is tested separately.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    getConversationById: vi.fn(),
    getUsageLogs: vi.fn(),
  },
  calculateUsageSummary: vi.fn(),
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock logging (boundary)
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

// Mock AI monitoring (boundary)
vi.mock('@pagespace/lib/ai-monitoring', () => ({
  getContextWindow: vi.fn(() => 200000),
}));

import {
  globalConversationRepository,
  calculateUsageSummary as mockedCalculateUsageSummary,
} from '@/lib/repositories/global-conversation-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { getContextWindow } from '@pagespace/lib/ai-monitoring';

// Test fixtures
const mockUserId = 'user_123';
const mockConversationId = 'conv_123';

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

const mockConversation = (overrides: Partial<{
  id: string;
  userId: string;
  isActive: boolean;
}> = {}) => ({
  id: overrides.id ?? mockConversationId,
  userId: overrides.userId ?? mockUserId,
  isActive: overrides.isActive ?? true,
  title: 'Test Conversation',
  type: 'global',
  contextId: null,
  lastMessageAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

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
  contextSize: number;
  messageCount: number;
  wasTruncated: boolean;
}> = {}) => ({
  id: overrides.id ?? 'log_123',
  timestamp: overrides.timestamp ?? new Date(),
  userId: overrides.userId ?? mockUserId,
  provider: overrides.provider ?? 'openrouter',
  model: overrides.model ?? 'anthropic/claude-3-opus',
  inputTokens: overrides.inputTokens ?? 1000,
  outputTokens: overrides.outputTokens ?? 500,
  totalTokens: overrides.totalTokens ?? 1500,
  cost: overrides.cost ?? 0.015,
  conversationId: overrides.conversationId ?? mockConversationId,
  messageId: null,
  pageId: null,
  driveId: null,
  success: true,
  error: null,
  contextSize: overrides.contextSize ?? 50000,
  messageCount: overrides.messageCount ?? 10,
  wasTruncated: overrides.wasTruncated ?? false,
});

const mockUsageSummary = (overrides: Partial<{
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  currentContextSize: number;
  messagesInContext: number;
  contextWindowSize: number;
  contextUsagePercent: number;
  wasTruncated: boolean;
  mostRecentModel: string | null;
  mostRecentProvider: string | null;
  hasContext: boolean;
}> = {}) => ({
  billing: {
    totalInputTokens: overrides.totalInputTokens ?? 3000,
    totalOutputTokens: overrides.totalOutputTokens ?? 1300,
    totalTokens: overrides.totalTokens ?? 4300,
    totalCost: overrides.totalCost ?? 0.03,
  },
  context: overrides.hasContext !== false ? {
    currentContextSize: overrides.currentContextSize ?? 50000,
    messagesInContext: overrides.messagesInContext ?? 10,
    contextWindowSize: overrides.contextWindowSize ?? 200000,
    contextUsagePercent: overrides.contextUsagePercent ?? 25,
    wasTruncated: overrides.wasTruncated ?? false,
  } : null,
  mostRecentModel: overrides.mostRecentModel ?? 'anthropic/claude-3-opus',
  mostRecentProvider: overrides.mostRecentProvider ?? 'openrouter',
});

const createContext = (id: string) => ({
  params: Promise.resolve({ id }),
});

const createRequest = (id: string) =>
  new Request(`https://example.com/api/ai/global/${id}/usage`, { method: 'GET' });

describe('GET /api/ai/global/[id]/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: conversation exists
    vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(
      mockConversation()
    );

    // Default: no usage logs
    vi.mocked(globalConversationRepository.getUsageLogs).mockResolvedValue([]);

    // Default: empty summary
    vi.mocked(mockedCalculateUsageSummary).mockReturnValue(
      mockUsageSummary({ hasContext: false })
    );
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await GET(request, context);

      expect(response.status).toBe(401);
    });
  });

  describe('conversation not found', () => {
    it('should return 404 when conversation does not exist', async () => {
      vi.mocked(globalConversationRepository.getConversationById).mockResolvedValue(null);

      const request = createRequest(mockConversationId);
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
        mockUsageLog({ inputTokens: 1000, outputTokens: 500 }),
        mockUsageLog({ inputTokens: 2000, outputTokens: 800 }),
      ];
      vi.mocked(globalConversationRepository.getUsageLogs).mockResolvedValue(usageLogs);
      vi.mocked(mockedCalculateUsageSummary).mockReturnValue(mockUsageSummary());

      const request = createRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.logs).toBeDefined();
      expect(body.summary).toBeDefined();
      expect(body.summary.billing).toBeDefined();
    });

    it('should call repository methods with correct arguments', async () => {
      const request = createRequest(mockConversationId);
      const context = createContext(mockConversationId);

      await GET(request, context);

      expect(globalConversationRepository.getConversationById).toHaveBeenCalledWith(
        mockUserId,
        mockConversationId
      );
      expect(globalConversationRepository.getUsageLogs).toHaveBeenCalledWith(mockConversationId);
    });

    it('should pass getContextWindow to calculateUsageSummary', async () => {
      const usageLogs = [mockUsageLog()];
      vi.mocked(globalConversationRepository.getUsageLogs).mockResolvedValue(usageLogs);

      const request = createRequest(mockConversationId);
      const context = createContext(mockConversationId);

      await GET(request, context);

      expect(mockedCalculateUsageSummary).toHaveBeenCalledWith(usageLogs, getContextWindow);
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(globalConversationRepository.getConversationById).mockRejectedValue(
        new Error('Database error')
      );

      const request = createRequest(mockConversationId);
      const context = createContext(mockConversationId);

      const response = await GET(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch AI usage');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});

describe('calculateUsageSummary (pure function)', () => {
  // Import the actual function for pure function tests
  const actualModule = vi.importActual<typeof import('@/lib/repositories/global-conversation-repository')>(
    '@/lib/repositories/global-conversation-repository'
  );

  const mockGetContextWindow = vi.fn(() => 200000);

  it('should calculate billing totals correctly', async () => {
    const { calculateUsageSummary } = await actualModule;
    const logs = [
      mockUsageLog({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.01 }),
      mockUsageLog({ inputTokens: 2000, outputTokens: 800, totalTokens: 2800, cost: 0.02 }),
    ];

    const result = calculateUsageSummary(logs, mockGetContextWindow);

    expect(result.billing.totalInputTokens).toBe(3000);
    expect(result.billing.totalOutputTokens).toBe(1300);
    expect(result.billing.totalTokens).toBe(4300);
    expect(result.billing.totalCost).toBe(0.03);
  });

  it('should return zero totals for empty logs', async () => {
    const { calculateUsageSummary } = await actualModule;

    const result = calculateUsageSummary([], mockGetContextWindow);

    expect(result.billing.totalInputTokens).toBe(0);
    expect(result.billing.totalOutputTokens).toBe(0);
    expect(result.billing.totalTokens).toBe(0);
    expect(result.billing.totalCost).toBe(0);
    expect(result.context).toBeNull();
  });

  it('should extract context info from most recent log', async () => {
    const { calculateUsageSummary } = await actualModule;
    const logs = [
      mockUsageLog({
        contextSize: 75000,
        messageCount: 15,
        wasTruncated: false,
        model: 'anthropic/claude-3-opus',
        provider: 'openrouter',
      }),
    ];

    const result = calculateUsageSummary(logs, mockGetContextWindow);

    expect(result.context?.currentContextSize).toBe(75000);
    expect(result.context?.messagesInContext).toBe(15);
    expect(result.context?.wasTruncated).toBe(false);
    expect(result.mostRecentModel).toBe('anthropic/claude-3-opus');
    expect(result.mostRecentProvider).toBe('openrouter');
  });

  it('should calculate context usage percentage correctly', async () => {
    const { calculateUsageSummary } = await actualModule;
    const logs = [mockUsageLog({ contextSize: 100000 })];
    mockGetContextWindow.mockReturnValue(200000);

    const result = calculateUsageSummary(logs, mockGetContextWindow);

    expect(result.context?.contextUsagePercent).toBe(50);
    expect(result.context?.contextWindowSize).toBe(200000);
  });

  it('should round cost to 6 decimal places', async () => {
    const { calculateUsageSummary } = await actualModule;
    const logs = [
      mockUsageLog({ cost: 0.00000123456789 }),
      mockUsageLog({ cost: 0.00000987654321 }),
    ];

    const result = calculateUsageSummary(logs, mockGetContextWindow);

    // Should be rounded to 6 decimal places
    expect(result.billing.totalCost.toString().split('.')[1]?.length || 0).toBeLessThanOrEqual(6);
  });

  it('should handle null token values gracefully', async () => {
    const { calculateUsageSummary } = await actualModule;
    const logs = [
      {
        ...mockUsageLog(),
        inputTokens: null as unknown as number,
        outputTokens: null as unknown as number,
        totalTokens: null as unknown as number,
        cost: null as unknown as number,
      },
    ];

    const result = calculateUsageSummary(logs, mockGetContextWindow);

    expect(result.billing.totalInputTokens).toBe(0);
    expect(result.billing.totalOutputTokens).toBe(0);
    expect(result.billing.totalTokens).toBe(0);
    expect(result.billing.totalCost).toBe(0);
  });
});
