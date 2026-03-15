/**
 * Tests for conversation-repository.ts
 * Repository for conversation database operations.
 * Also tests pure helpers: extractPreviewText, generateTitle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecute = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());
const mockSelectFrom = vi.hoisted(() => vi.fn());
const mockSelectWhere = vi.hoisted(() => vi.fn());
const mockSelectLimit = vi.hoisted(() => vi.fn());
const mockUpdateSet = vi.hoisted(() => vi.fn());
const mockUpdateWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInsertValues = vi.hoisted(() => vi.fn());
const mockInsertOnConflict = vi.hoisted(() => vi.fn());
const mockInsertReturning = vi.hoisted(() => vi.fn().mockResolvedValue([{ id: 'conv-1', title: 'Title' }]));
const mockDbInsert = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findFirst: mockFindFirst },
    },
    execute: mockExecute,
    select: mockSelect,
    update: vi.fn(() => ({ set: mockUpdateSet })),
    insert: mockDbInsert,
  },
  chatMessages: {
    id: 'id',
    pageId: 'pageId',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
  },
  pages: {
    id: 'id',
    type: 'type',
    isTrashed: 'isTrashed',
    title: 'title',
    driveId: 'driveId',
  },
  userActivities: {
    userId: 'userId',
    action: 'action',
    resource: 'resource',
    resourceId: 'resourceId',
    pageId: 'pageId',
    metadata: 'metadata',
  },
  conversations: {
    id: 'id',
    userId: 'userId',
    type: 'type',
    contextId: 'contextId',
    title: 'title',
    updatedAt: 'updatedAt',
  },
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  sql: Object.assign(
    vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => ({
      raw: parts,
      values,
      as: vi.fn((alias: string) => ({ raw: parts, values, alias })),
    })),
    { placeholder: vi.fn() }
  ),
}));

import {
  conversationRepository,
  extractPreviewText,
  generateTitle,
} from '../conversation-repository';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockSelect.mockReturnValue({ from: mockSelectFrom });
  mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
  mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
  mockSelectLimit.mockResolvedValue([]);
  mockDbInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockInsertOnConflict });
  mockInsertOnConflict.mockReturnValue({ returning: mockInsertReturning });
  mockExecute.mockResolvedValue({ rows: [] });
});

// ---------------------------------------------------------------------------
// extractPreviewText (pure function)
// ---------------------------------------------------------------------------

describe('extractPreviewText', () => {
  it('should return "New conversation" for null', () => {
    expect(extractPreviewText(null)).toBe('New conversation');
  });

  it('should return "New conversation" for empty string', () => {
    expect(extractPreviewText('')).toBe('New conversation');
  });

  it('should return raw content substring for plain text', () => {
    expect(extractPreviewText('Hello world')).toBe('Hello world');
  });

  it('should truncate plain text to 100 characters', () => {
    const long = 'a'.repeat(150);
    expect(extractPreviewText(long)).toHaveLength(100);
  });

  it('should extract originalContent from structured JSON', () => {
    const structured = JSON.stringify({ originalContent: 'Hello from original' });
    expect(extractPreviewText(structured)).toBe('Hello from original');
  });

  it('should extract first textPart when no originalContent', () => {
    const structured = JSON.stringify({ textParts: ['first text part'] });
    expect(extractPreviewText(structured)).toBe('first text part');
  });

  it('should extract parts[0].text from parts format', () => {
    const structured = JSON.stringify({ parts: [{ text: 'parts format text' }] });
    expect(extractPreviewText(structured)).toBe('parts format text');
  });

  it('should extract text from legacy array format', () => {
    const legacy = JSON.stringify([{ text: 'legacy text content' }]);
    expect(extractPreviewText(legacy)).toBe('legacy text content');
  });

  it('should return content substring when JSON does not match any known format', () => {
    const json = JSON.stringify({ unknownKey: 'value' });
    expect(extractPreviewText(json)).toBe(json.substring(0, 100));
  });

  it('should truncate originalContent to 100 chars', () => {
    const long = 'b'.repeat(200);
    const structured = JSON.stringify({ originalContent: long });
    expect(extractPreviewText(structured)).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// generateTitle (pure function)
// ---------------------------------------------------------------------------

describe('generateTitle', () => {
  it('should return preview as-is when under 50 chars', () => {
    expect(generateTitle('Short title')).toBe('Short title');
  });

  it('should truncate to 50 chars and append ellipsis when over 50 chars', () => {
    const long = 'a'.repeat(60);
    const result = generateTitle(long);
    expect(result).toBe('a'.repeat(50) + '...');
  });

  it('should not truncate at exactly 50 chars', () => {
    const exactly50 = 'x'.repeat(50);
    expect(generateTitle(exactly50)).toBe(exactly50);
  });
});

// ---------------------------------------------------------------------------
// getAiAgent
// ---------------------------------------------------------------------------

describe('conversationRepository.getAiAgent', () => {
  it('should return agent when found', async () => {
    const agent = { id: 'agent-1', title: 'My Agent', type: 'AI_CHAT', driveId: 'drive-1' };
    mockFindFirst.mockResolvedValue(agent);

    const result = await conversationRepository.getAiAgent('agent-1');
    expect(result).toEqual(agent);
  });

  it('should return null when agent not found', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const result = await conversationRepository.getAiAgent('nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listConversations
// ---------------------------------------------------------------------------

describe('conversationRepository.listConversations', () => {
  it('should return conversation stats rows', async () => {
    const rows = [
      {
        conversationId: 'conv-1',
        firstMessageTime: new Date(),
        lastMessageTime: new Date(),
        messageCount: 5,
        firstUserMessage: 'Hello',
        lastMessageRole: 'assistant',
        lastMessageContent: 'Hi there',
      },
    ];
    mockExecute.mockResolvedValue({ rows });

    const result = await conversationRepository.listConversations('agent-1', 10, 0);
    expect(result).toEqual(rows);
  });

  it('should return empty array when no conversations', async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    const result = await conversationRepository.listConversations('agent-1', 10, 0);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countConversations
// ---------------------------------------------------------------------------

describe('conversationRepository.countConversations', () => {
  it('should return count from result', async () => {
    mockSelectWhere.mockResolvedValue([{ count: 7 }]);
    const count = await conversationRepository.countConversations('agent-1');
    expect(count).toBe(7);
  });

  it('should return 0 when result is empty', async () => {
    mockSelectWhere.mockResolvedValue([]);
    const count = await conversationRepository.countConversations('agent-1');
    expect(count).toBe(0);
  });

  it('should handle null count', async () => {
    mockSelectWhere.mockResolvedValue([{ count: null }]);
    const count = await conversationRepository.countConversations('agent-1');
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// conversationExists
// ---------------------------------------------------------------------------

describe('conversationRepository.conversationExists', () => {
  it('should return true when conversation has messages', async () => {
    mockSelectLimit.mockResolvedValue([{ id: 'msg-1' }]);
    const result = await conversationRepository.conversationExists('agent-1', 'conv-1');
    expect(result).toBe(true);
  });

  it('should return false when no messages', async () => {
    mockSelectLimit.mockResolvedValue([]);
    const result = await conversationRepository.conversationExists('agent-1', 'conv-2');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getConversationMetadata
// ---------------------------------------------------------------------------

describe('conversationRepository.getConversationMetadata', () => {
  it('should return metadata when found', async () => {
    const meta = {
      messageCount: 10,
      firstMessageTime: new Date('2024-01-01'),
      lastMessageTime: new Date('2024-03-01'),
    };
    mockSelectWhere.mockResolvedValue([meta]);
    const result = await conversationRepository.getConversationMetadata('agent-1', 'conv-1');
    expect(result).toEqual(meta);
  });

  it('should return null when no result', async () => {
    mockSelectWhere.mockResolvedValue([]);
    const result = await conversationRepository.getConversationMetadata('agent-1', 'conv-1');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// softDeleteConversation
// ---------------------------------------------------------------------------

describe('conversationRepository.softDeleteConversation', () => {
  it('should set isActive to false for all messages in conversation', async () => {
    await conversationRepository.softDeleteConversation('agent-1', 'conv-1');
    expect(db.update).toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false })
    );
  });
});

// ---------------------------------------------------------------------------
// upsertConversationTitle
// ---------------------------------------------------------------------------

describe('conversationRepository.upsertConversationTitle', () => {
  it('should insert or update conversation title and return id/title', async () => {
    mockInsertReturning.mockResolvedValue([{ id: 'conv-1', title: 'New Title' }]);

    const result = await conversationRepository.upsertConversationTitle(
      'conv-1',
      'user-1',
      'agent-1',
      'New Title'
    );
    expect(result).toEqual({ id: 'conv-1', title: 'New Title' });
    expect(mockDbInsert).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logConversationDeletion
// ---------------------------------------------------------------------------

describe('conversationRepository.logConversationDeletion', () => {
  it('should insert an activity log entry', async () => {
    // logConversationDeletion uses db.insert without returning
    mockInsertValues.mockResolvedValue(undefined);

    await conversationRepository.logConversationDeletion({
      userId: 'user-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      metadata: { messageCount: 5, firstMessageTime: new Date(), lastMessageTime: new Date() },
    });

    expect(mockDbInsert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'delete',
        resource: 'conversation',
        resourceId: 'conv-1',
      })
    );
  });

  it('should handle null metadata gracefully', async () => {
    mockInsertValues.mockResolvedValue(undefined);

    await expect(
      conversationRepository.logConversationDeletion({
        userId: 'user-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        metadata: null,
      })
    ).resolves.not.toThrow();
  });
});
