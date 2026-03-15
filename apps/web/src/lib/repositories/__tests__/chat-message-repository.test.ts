/**
 * Tests for chat-message-repository.ts
 * Repository for chat message database operations.
 * Also tests pure helper: processMessageContentUpdate
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
const mockSelectWhere = vi.hoisted(() => vi.fn().mockReturnValue({ orderBy: mockOrderBy }));
const mockSelectFrom = vi.hoisted(() => vi.fn().mockReturnValue({ where: mockSelectWhere }));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockSelectFrom })),
    update: vi.fn(() => ({ set: mockUpdateSet })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
  },
  chatMessages: {
    id: 'id',
    pageId: 'pageId',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
    content: 'content',
    editedAt: 'editedAt',
  },
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
}));

import { chatMessageRepository, processMessageContentUpdate } from '../chat-message-repository';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockReturning.mockResolvedValue([]);
  mockDeleteWhere.mockReturnValue({ returning: mockReturning });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockSelectWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockOrderBy.mockResolvedValue([]);
  vi.mocked(db.select).mockReturnValue({ from: mockSelectFrom } as never);
  vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as never);
  vi.mocked(db.delete).mockReturnValue({ where: mockDeleteWhere } as never);
});

// ---------------------------------------------------------------------------
// processMessageContentUpdate (pure function)
// ---------------------------------------------------------------------------

describe('processMessageContentUpdate', () => {
  it('should return newContent as-is for plain text', () => {
    expect(processMessageContentUpdate('old plain text', 'new content')).toBe('new content');
  });

  it('should update textParts in structured content preserving structure', () => {
    const existing = JSON.stringify({
      textParts: ['old text'],
      partsOrder: ['text'],
      originalContent: 'old text',
    });
    const result = processMessageContentUpdate(existing, 'new text');
    const parsed = JSON.parse(result);
    expect(parsed.textParts).toEqual(['new text']);
    expect(parsed.originalContent).toBe('new text');
    expect(parsed.partsOrder).toEqual(['text']); // preserved
  });

  it('should return newContent when existing is valid JSON but has no textParts+partsOrder', () => {
    const existing = JSON.stringify({ data: 'some object' });
    expect(processMessageContentUpdate(existing, 'new content')).toBe('new content');
  });

  it('should return newContent when existing JSON parsing fails', () => {
    expect(processMessageContentUpdate('{invalid json}', 'new content')).toBe('new content');
  });

  it('should handle empty existing content', () => {
    expect(processMessageContentUpdate('', 'new')).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// getMessagesForPage
// ---------------------------------------------------------------------------

describe('chatMessageRepository.getMessagesForPage', () => {
  it('should query messages with pageId filter only when no conversationId', async () => {
    const messages = [
      { id: 'msg-1', pageId: 'page-1', conversationId: 'conv-1', isActive: true },
    ];
    mockOrderBy.mockResolvedValue(messages);

    const result = await chatMessageRepository.getMessagesForPage('page-1');
    expect(result).toEqual(messages);
    expect(db.select).toHaveBeenCalled();
  });

  it('should query with conversationId filter when provided', async () => {
    mockOrderBy.mockResolvedValue([]);
    await chatMessageRepository.getMessagesForPage('page-1', 'conv-1');
    expect(mockSelectWhere).toHaveBeenCalled();
  });

  it('should return empty array when no messages found', async () => {
    mockOrderBy.mockResolvedValue([]);
    const result = await chatMessageRepository.getMessagesForPage('page-no-messages');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getMessageById
// ---------------------------------------------------------------------------

describe('chatMessageRepository.getMessageById', () => {
  it('should return message when found', async () => {
    const message = { id: 'msg-1', pageId: 'page-1', conversationId: 'conv-1', isActive: true };
    // getMessageById uses select().from().where() without orderBy - returns array
    mockSelectWhere.mockResolvedValue([message]);

    const result = await chatMessageRepository.getMessageById('msg-1');
    expect(result).toEqual(message);
  });

  it('should return null when message not found', async () => {
    mockSelectWhere.mockResolvedValue([]);
    const result = await chatMessageRepository.getMessageById('nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateMessageContent
// ---------------------------------------------------------------------------

describe('chatMessageRepository.updateMessageContent', () => {
  it('should call db.update with the new content and editedAt', async () => {
    await chatMessageRepository.updateMessageContent('msg-1', 'updated content');
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'updated content', editedAt: expect.any(Date) })
    );
    expect(mockUpdateWhere).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// softDeleteMessage
// ---------------------------------------------------------------------------

describe('chatMessageRepository.softDeleteMessage', () => {
  it('should set isActive to false', async () => {
    await chatMessageRepository.softDeleteMessage('msg-1');
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false })
    );
  });
});

// ---------------------------------------------------------------------------
// hardDeleteMessage
// ---------------------------------------------------------------------------

describe('chatMessageRepository.hardDeleteMessage', () => {
  it('should call db.delete with the message ID', async () => {
    await chatMessageRepository.hardDeleteMessage('msg-1');
    expect(db.delete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// purgeInactiveMessages
// ---------------------------------------------------------------------------

describe('chatMessageRepository.purgeInactiveMessages', () => {
  it('should return count of deleted messages', async () => {
    mockReturning.mockResolvedValue([{ id: 'msg-1' }, { id: 'msg-2' }, { id: 'msg-3' }]);
    const count = await chatMessageRepository.purgeInactiveMessages(new Date('2024-01-01'));
    expect(count).toBe(3);
  });

  it('should return 0 when no messages match', async () => {
    mockReturning.mockResolvedValue([]);
    const count = await chatMessageRepository.purgeInactiveMessages(new Date());
    expect(count).toBe(0);
  });

  it('should call db.delete with isActive=false and lt condition', async () => {
    mockReturning.mockResolvedValue([]);
    await chatMessageRepository.purgeInactiveMessages(new Date('2024-06-01'));
    expect(db.delete).toHaveBeenCalled();
    expect(mockDeleteWhere).toHaveBeenCalled();
  });
});
