/**
 * Unit tests for conversationRepository.
 *
 * The repository is the seam where ORM/query-builder details are isolated.
 * These tests mock @pagespace/db/db to verify the seam delegates to Drizzle
 * with the correct shapes. Route/service tests mock the repository instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock chains
const mockSelectChain = vi.hoisted(() => ({
  from: vi.fn(),
}));

const mockInsertChain = vi.hoisted(() => ({
  values: vi.fn(),
}));

const mockUpdateChain = vi.hoisted(() => ({
  set: vi.fn(),
}));

const mockExecute = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => mockSelectChain),
    insert: vi.fn(() => mockInsertChain),
    update: vi.fn(() => mockUpdateChain),
    execute: mockExecute,
    query: {
      pages: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conds) => ({ kind: 'and', conds })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      kind: 'sql',
      strings,
      values,
    })),
    { as: vi.fn() }
  ),
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'conversations.id',
    userId: 'conversations.userId',
    isShared: 'conversations.isShared',
    updatedAt: 'conversations.updatedAt',
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: {
    id: 'chatMessages.id',
    pageId: 'chatMessages.pageId',
    conversationId: 'chatMessages.conversationId',
    isActive: 'chatMessages.isActive',
  },
  pages: { id: 'pages.id', type: 'pages.type', isTrashed: 'pages.isTrashed' },
}));

vi.mock('@pagespace/db/schema/monitoring', () => ({
  userActivities: { userId: 'userActivities.userId' },
}));

import { conversationRepository } from '../conversation-repository';
import { db } from '@pagespace/db/db';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('conversationRepository.getConversation', () => {
  it('should return the conversations row when found', async () => {
    const mockRow = {
      id: 'conv_abc',
      userId: 'user_123',
      isShared: false,
      type: 'page',
      contextId: 'agent_456',
      title: null,
      isActive: true,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-02'),
    };

    const whereMock = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([mockRow]),
    });
    mockSelectChain.from.mockReturnValue({ where: whereMock });

    const result = await conversationRepository.getConversation('conv_abc');

    expect(result).toEqual(mockRow);
  });

  it('should return null when conversation row does not exist', async () => {
    const whereMock = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([]),
    });
    mockSelectChain.from.mockReturnValue({ where: whereMock });

    const result = await conversationRepository.getConversation('conv_missing');

    expect(result).toBeNull();
  });
});

describe('conversationRepository.setConversationShared', () => {
  it('should update isShared to true for a conversation', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockUpdateChain.set.mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await conversationRepository.setConversationShared('conv_abc', true);

    expect(mockDb.update).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ isShared: true })
    );
  });

  it('should update isShared to false for a conversation', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    mockDb.update = vi.fn().mockReturnValue({ set: setMock });

    await conversationRepository.setConversationShared('conv_abc', false);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ isShared: false })
    );
  });
});
