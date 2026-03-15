/**
 * Tests for global-conversation-repository.ts
 * Repository for global conversation routes.
 * Also tests pure function: calculateUsageSummary
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockDeleteWhere = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));
const mockUpdateWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdateSet = vi.hoisted(() => vi.fn().mockReturnValue({ where: mockUpdateWhere }));
const mockOrderBy = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockLimit = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockReturning }));
const mockSelectWhere = vi.hoisted(() => vi.fn().mockReturnValue({ orderBy: mockOrderBy }));
const mockSelectFrom = vi.hoisted(() => vi.fn().mockReturnValue({ where: mockSelectWhere }));
const mockInsertReturning = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockInsertValues = vi.hoisted(() => vi.fn().mockReturnValue({ returning: mockInsertReturning }));
const mockCursorSelect = vi.hoisted(() => vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }));

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockCursorSelect,
    update: vi.fn(() => ({ set: mockUpdateSet })),
    insert: vi.fn(() => ({ values: mockInsertValues })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
  },
  conversations: {
    id: 'id',
    userId: 'userId',
    type: 'type',
    contextId: 'contextId',
    title: 'title',
    lastMessageAt: 'lastMessageAt',
    createdAt: 'createdAt',
    isActive: 'isActive',
    updatedAt: 'updatedAt',
  },
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    content: 'content',
    role: 'role',
    isActive: 'isActive',
    createdAt: 'createdAt',
    editedAt: 'editedAt',
  },
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
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  desc: vi.fn((field) => ({ type: 'desc', field })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  sql: Object.assign(
    vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => ({ raw: parts, values })),
    { placeholder: vi.fn() }
  ),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-generated-id'),
}));

import {
  globalConversationRepository,
  calculateUsageSummary,
  type UsageLog,
} from '../global-conversation-repository';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockReturning.mockResolvedValue([]);
  mockDeleteWhere.mockReturnValue({ returning: mockReturning });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockOrderBy.mockResolvedValue([]);
  mockSelectWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
  vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);
  vi.mocked(db.delete).mockReturnValue({ where: mockDeleteWhere } as never);
  vi.mocked(db.insert).mockReturnValue({ values: mockInsertValues } as never);

  // Reset the main select mock to chain properly
  mockCursorSelect.mockReturnValue({ from: mockSelectFrom });
});

// ---------------------------------------------------------------------------
// calculateUsageSummary (pure function)
// ---------------------------------------------------------------------------

describe('calculateUsageSummary', () => {
  const getContextWindow = (model: string) => (model === 'claude-3-5-sonnet' ? 200000 : 128000);

  it('should return zero billing when logs array is empty', () => {
    const result = calculateUsageSummary([], getContextWindow);
    expect(result.billing.totalInputTokens).toBe(0);
    expect(result.billing.totalOutputTokens).toBe(0);
    expect(result.billing.totalTokens).toBe(0);
    expect(result.billing.totalCost).toBe(0);
    expect(result.context).toBeNull();
    expect(result.mostRecentModel).toBeNull();
    expect(result.mostRecentProvider).toBeNull();
  });

  it('should aggregate token counts across multiple logs', () => {
    const logs: UsageLog[] = [
      { id: '1', timestamp: new Date(), userId: 'u1', provider: 'anthropic', model: 'claude-3-5-sonnet', inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.001, conversationId: 'c1', messageId: null, pageId: null, driveId: null, success: true, error: null, contextSize: 500, messageCount: 3, wasTruncated: false },
      { id: '2', timestamp: new Date(), userId: 'u1', provider: 'anthropic', model: 'claude-3-5-sonnet', inputTokens: 2000, outputTokens: 800, totalTokens: 2800, cost: 0.002, conversationId: 'c1', messageId: null, pageId: null, driveId: null, success: true, error: null, contextSize: 1000, messageCount: 5, wasTruncated: false },
    ];

    const result = calculateUsageSummary(logs, getContextWindow);
    expect(result.billing.totalInputTokens).toBe(3000);
    expect(result.billing.totalOutputTokens).toBe(1300);
    expect(result.billing.totalTokens).toBe(4300);
  });

  it('should use the first log for most recent model and provider', () => {
    const logs: UsageLog[] = [
      { id: '1', timestamp: new Date(), userId: null, provider: 'anthropic', model: 'claude-3-5-sonnet', inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.0001, conversationId: null, messageId: null, pageId: null, driveId: null, success: true, error: null, contextSize: 200, messageCount: 2, wasTruncated: false },
    ];

    const result = calculateUsageSummary(logs, getContextWindow);
    expect(result.mostRecentModel).toBe('claude-3-5-sonnet');
    expect(result.mostRecentProvider).toBe('anthropic');
  });

  it('should calculate context usage percent', () => {
    const logs: UsageLog[] = [
      { id: '1', timestamp: new Date(), userId: null, provider: 'anthropic', model: 'claude-3-5-sonnet', inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.0001, conversationId: null, messageId: null, pageId: null, driveId: null, success: true, error: null, contextSize: 100000, messageCount: 10, wasTruncated: false },
    ];

    const result = calculateUsageSummary(logs, getContextWindow);
    expect(result.context).not.toBeNull();
    // 100000/200000 = 50%
    expect(result.context?.contextUsagePercent).toBe(50);
  });

  it('should include wasTruncated from most recent log', () => {
    const logs: UsageLog[] = [
      { id: '1', timestamp: new Date(), userId: null, provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.0001, conversationId: null, messageId: null, pageId: null, driveId: null, success: true, error: null, contextSize: 5000, messageCount: 4, wasTruncated: true },
    ];

    const result = calculateUsageSummary(logs, getContextWindow);
    expect(result.context?.wasTruncated).toBe(true);
  });

  it('should handle null token values gracefully', () => {
    const logs: UsageLog[] = [
      { id: '1', timestamp: null, userId: null, provider: null, model: null, inputTokens: null, outputTokens: null, totalTokens: null, cost: null, conversationId: null, messageId: null, pageId: null, driveId: null, success: null, error: null, contextSize: null, messageCount: null, wasTruncated: null },
    ];

    const result = calculateUsageSummary(logs, getContextWindow);
    expect(result.billing.totalInputTokens).toBe(0);
    expect(result.billing.totalCost).toBe(0);
  });

  it('should round totalCost to 6 decimal places', () => {
    const logs: UsageLog[] = [
      { id: '1', timestamp: new Date(), userId: null, provider: 'anthropic', model: 'claude-3-5-sonnet', inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0.0000001, conversationId: null, messageId: null, pageId: null, driveId: null, success: true, error: null, contextSize: 10, messageCount: 1, wasTruncated: false },
      { id: '2', timestamp: new Date(), userId: null, provider: 'anthropic', model: 'claude-3-5-sonnet', inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0.0000002, conversationId: null, messageId: null, pageId: null, driveId: null, success: true, error: null, contextSize: 10, messageCount: 1, wasTruncated: false },
    ];

    const result = calculateUsageSummary(logs, getContextWindow);
    // Cost should be rounded to 6 decimal places
    expect(result.billing.totalCost).toBe(Number((0.0000003).toFixed(6)));
  });
});

// ---------------------------------------------------------------------------
// listConversations
// ---------------------------------------------------------------------------

describe('globalConversationRepository.listConversations', () => {
  it('should return conversations ordered by lastMessageAt', async () => {
    const convs = [
      { id: 'conv-1', title: 'Conversation 1', type: 'global', contextId: null, lastMessageAt: new Date(), createdAt: new Date() },
    ];
    mockOrderBy.mockResolvedValue(convs);

    const result = await globalConversationRepository.listConversations('user-1');
    expect(result).toEqual(convs);
  });

  it('should return empty array when no conversations', async () => {
    mockOrderBy.mockResolvedValue([]);
    const result = await globalConversationRepository.listConversations('user-1');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createConversation
// ---------------------------------------------------------------------------

describe('globalConversationRepository.createConversation', () => {
  it('should insert and return new conversation', async () => {
    const newConv = {
      id: 'test-generated-id',
      userId: 'user-1',
      title: 'My Conversation',
      type: 'global',
      contextId: null,
      isActive: true,
      lastMessageAt: expect.any(Date),
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    };
    mockInsertReturning.mockResolvedValue([newConv]);

    const result = await globalConversationRepository.createConversation('user-1', { title: 'My Conversation' });
    expect(result).toEqual(newConv);
    expect(db.insert).toHaveBeenCalled();
  });

  it('should use default type "global" when type not specified', async () => {
    const newConv = { id: 'test-generated-id', userId: 'user-1', type: 'global', isActive: true };
    mockInsertReturning.mockResolvedValue([newConv]);

    await globalConversationRepository.createConversation('user-1', {});
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'global' })
    );
  });
});

// ---------------------------------------------------------------------------
// getActiveGlobalConversation
// ---------------------------------------------------------------------------

describe('globalConversationRepository.getActiveGlobalConversation', () => {
  it('should return the most recent active global conversation', async () => {
    const conv = { id: 'conv-1', title: null, type: 'global', contextId: null, lastMessageAt: new Date(), createdAt: new Date() };
    // getActiveGlobalConversation chains: select().from().where().orderBy().limit()
    const mockLimitFn = vi.fn().mockResolvedValue([conv]);
    const mockOrderByFn = vi.fn().mockReturnValue({ limit: mockLimitFn });
    mockSelectWhere.mockReturnValue({ orderBy: mockOrderByFn });

    const result = await globalConversationRepository.getActiveGlobalConversation('user-1');
    expect(result).toEqual(conv);
  });

  it('should return null when no active global conversation', async () => {
    const mockLimitFn = vi.fn().mockResolvedValue([]);
    const mockOrderByFn = vi.fn().mockReturnValue({ limit: mockLimitFn });
    mockSelectWhere.mockReturnValue({ orderBy: mockOrderByFn });

    const result = await globalConversationRepository.getActiveGlobalConversation('user-1');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getConversationById
// ---------------------------------------------------------------------------

describe('globalConversationRepository.getConversationById', () => {
  it('should return conversation when found', async () => {
    const conv = { id: 'conv-1', userId: 'user-1', isActive: true, type: 'global' };
    mockSelectWhere.mockResolvedValue([conv]);

    const result = await globalConversationRepository.getConversationById('user-1', 'conv-1');
    expect(result).toEqual(conv);
  });

  it('should return null when not found', async () => {
    mockSelectWhere.mockResolvedValue([]);
    const result = await globalConversationRepository.getConversationById('user-1', 'conv-x');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateConversationTitle
// ---------------------------------------------------------------------------

describe('globalConversationRepository.updateConversationTitle', () => {
  it('should update title and return updated conversation', async () => {
    const updated = { id: 'conv-1', userId: 'user-1', title: 'New Title', isActive: true };
    mockUpdateWhere.mockResolvedValue([updated]);
    // The repo uses .returning() after .where()
    const mockReturningFn = vi.fn().mockResolvedValue([updated]);
    mockUpdateWhere.mockReturnValue({ returning: mockReturningFn } as never);

    const result = await globalConversationRepository.updateConversationTitle('user-1', 'conv-1', 'New Title');
    expect(result).toEqual(updated);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New Title' })
    );
  });

  it('should return null when conversation not found', async () => {
    const mockReturningFn = vi.fn().mockResolvedValue([]);
    mockUpdateWhere.mockReturnValue({ returning: mockReturningFn } as never);

    const result = await globalConversationRepository.updateConversationTitle('user-1', 'conv-x', 'Title');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// softDeleteConversation
// ---------------------------------------------------------------------------

describe('globalConversationRepository.softDeleteConversation', () => {
  it('should set isActive to false and return deleted conversation', async () => {
    const deleted = { id: 'conv-1', isActive: false };
    const mockReturningFn = vi.fn().mockResolvedValue([deleted]);
    mockUpdateWhere.mockReturnValue({ returning: mockReturningFn } as never);

    const result = await globalConversationRepository.softDeleteConversation('user-1', 'conv-1');
    expect(result).toEqual(deleted);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false })
    );
  });
});

// ---------------------------------------------------------------------------
// getMessageById
// ---------------------------------------------------------------------------

describe('globalConversationRepository.getMessageById', () => {
  it('should return message when found', async () => {
    const msg = { id: 'msg-1', conversationId: 'conv-1', content: 'Hello', role: 'user', isActive: true };
    mockSelectWhere.mockResolvedValue([msg]);

    const result = await globalConversationRepository.getMessageById('conv-1', 'msg-1');
    expect(result).toEqual(msg);
  });

  it('should return null when message not found', async () => {
    mockSelectWhere.mockResolvedValue([]);
    const result = await globalConversationRepository.getMessageById('conv-1', 'no-msg');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateMessageContent
// ---------------------------------------------------------------------------

describe('globalConversationRepository.updateMessageContent', () => {
  it('should update message content and editedAt', async () => {
    await globalConversationRepository.updateMessageContent('msg-1', 'Updated content');
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Updated content', editedAt: expect.any(Date) })
    );
  });
});

// ---------------------------------------------------------------------------
// softDeleteMessage
// ---------------------------------------------------------------------------

describe('globalConversationRepository.softDeleteMessage', () => {
  it('should set isActive to false', async () => {
    await globalConversationRepository.softDeleteMessage('msg-1');
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false })
    );
  });
});

// ---------------------------------------------------------------------------
// getUsageLogs
// ---------------------------------------------------------------------------

describe('globalConversationRepository.getUsageLogs', () => {
  it('should return usage logs for a conversation', async () => {
    const logs = [
      { id: 'log-1', conversationId: 'conv-1', model: 'claude-3-5-sonnet', provider: 'anthropic' },
    ];
    mockOrderBy.mockResolvedValue(logs);

    const result = await globalConversationRepository.getUsageLogs('conv-1');
    expect(result).toEqual(logs);
  });

  it('should return empty array when no logs', async () => {
    mockOrderBy.mockResolvedValue([]);
    const result = await globalConversationRepository.getUsageLogs('conv-empty');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hardDeleteMessage
// ---------------------------------------------------------------------------

describe('globalConversationRepository.hardDeleteMessage', () => {
  it('should call db.delete with the message ID', async () => {
    await globalConversationRepository.hardDeleteMessage('msg-1');
    expect(db.delete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// purgeInactiveMessages
// ---------------------------------------------------------------------------

describe('globalConversationRepository.purgeInactiveMessages', () => {
  it('should return count of purged messages', async () => {
    mockReturning.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    const count = await globalConversationRepository.purgeInactiveMessages(new Date('2024-01-01'));
    expect(count).toBe(2);
  });

  it('should return 0 when no messages to purge', async () => {
    mockReturning.mockResolvedValue([]);
    const count = await globalConversationRepository.purgeInactiveMessages(new Date());
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// purgeInactiveConversations
// ---------------------------------------------------------------------------

describe('globalConversationRepository.purgeInactiveConversations', () => {
  it('should return count of purged conversations', async () => {
    mockReturning.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
    const count = await globalConversationRepository.purgeInactiveConversations(new Date('2024-01-01'));
    expect(count).toBe(3);
  });

  it('should return 0 when no conversations to purge', async () => {
    mockReturning.mockResolvedValue([]);
    const count = await globalConversationRepository.purgeInactiveConversations(new Date());
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listConversationsPaginated
// ---------------------------------------------------------------------------

describe('globalConversationRepository.listConversationsPaginated', () => {
  it('should return conversations with pagination metadata', async () => {
    const convs = Array.from({ length: 5 }, (_, i) => ({
      id: `conv-${i}`,
      title: null,
      type: 'global',
      contextId: null,
      lastMessageAt: new Date(),
      createdAt: new Date(),
    }));
    // limit + 1 = 21 items but only 5 returned — no more
    const mockLimitFn = vi.fn().mockResolvedValue(convs);
    const mockOrderByFn = vi.fn().mockReturnValue({ limit: mockLimitFn });
    mockSelectWhere.mockReturnValue({ orderBy: mockOrderByFn });

    const result = await globalConversationRepository.listConversationsPaginated('user-1', { limit: 20 });
    expect(result.conversations).toHaveLength(5);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
  });

  it('should indicate hasMore when result exceeds limit', async () => {
    // Return limit+1 items to signal more pages
    const convs = Array.from({ length: 21 }, (_, i) => ({
      id: `conv-${i}`,
      title: null,
      type: 'global',
      contextId: null,
      lastMessageAt: new Date(),
      createdAt: new Date(),
    }));
    const mockLimitFn = vi.fn().mockResolvedValue(convs);
    const mockOrderByFn = vi.fn().mockReturnValue({ limit: mockLimitFn });
    mockSelectWhere.mockReturnValue({ orderBy: mockOrderByFn });

    const result = await globalConversationRepository.listConversationsPaginated('user-1', { limit: 20 });
    expect(result.pagination.hasMore).toBe(true);
    expect(result.conversations).toHaveLength(20);
    expect(result.pagination.nextCursor).toBe('conv-19');
  });

  it('should cap limit at 100', async () => {
    const mockLimitFn = vi.fn().mockResolvedValue([]);
    const mockOrderByFn = vi.fn().mockReturnValue({ limit: mockLimitFn });
    mockSelectWhere.mockReturnValue({ orderBy: mockOrderByFn });

    await globalConversationRepository.listConversationsPaginated('user-1', { limit: 500 });
    // Called with 101 (max 100 + 1)
    expect(mockLimitFn).toHaveBeenCalledWith(101);
  });
});
