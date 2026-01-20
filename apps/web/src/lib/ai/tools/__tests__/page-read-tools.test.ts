import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    selectDistinct: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    query: {
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
      taskItems: { findFirst: vi.fn() },
      chatMessages: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id', driveId: 'driveId', type: 'type', isTrashed: 'isTrashed' },
  drives: { id: 'id' },
  taskItems: { pageId: 'pageId' },
  chatMessages: {
    id: 'id',
    pageId: 'pageId',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
    content: 'content',
    role: 'role',
    userId: 'userId',
  },
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  sql: vi.fn(),
  count: vi.fn(),
  max: vi.fn(),
  min: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserDriveAccess: vi.fn(),
  getUserAccessLevel: vi.fn(),
  getUserAccessiblePagesInDriveWithDetails: vi.fn(),
  canUserViewPage: vi.fn(),
  isDocumentPage: vi.fn((type) => type === 'DOCUMENT'),
  isAIChatPage: vi.fn((type) => type === 'AI_CHAT'),
  isChannelPage: vi.fn((type) => type === 'CHANNEL'),
  formatContentForAI: vi.fn((content) => content),
  formatSheetForAI: vi.fn(),
  formatTaskListForAI: vi.fn(),
  getPagePath: vi.fn().mockResolvedValue('/drive/page'),
  loggers: {
    ai: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

import { pageReadTools } from '../page-read-tools';
import { db } from '@pagespace/db';
import { getUserDriveAccess, getUserAccessLevel } from '@pagespace/lib/server';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockGetUserDriveAccess = vi.mocked(getUserDriveAccess);
const mockGetUserAccessLevel = vi.mocked(getUserAccessLevel);

const createMockPage = (content: string, type = 'DOCUMENT') => ({
  id: 'page-1',
  title: 'Test Page',
  type,
  content,
  isTrashed: false,
  driveId: 'drive-1',
});

const createAuthContext = (userId = 'user-123') => ({
  toolCallId: '1',
  messages: [],
  experimental_context: { userId } as ToolExecutionContext,
});

describe('page-read-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_pages', () => {
    it('has correct tool definition', () => {
      expect(pageReadTools.list_pages).toBeDefined();
      expect(pageReadTools.list_pages.description).toContain('List');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.list_pages.execute!({ driveId: 'drive-1' }, context)
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when drive not found', async () => {
      mockGetUserDriveAccess.mockResolvedValue(false);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageReadTools.list_pages.execute!({ driveId: 'non-existent' }, context)
      ).rejects.toThrow(); // Throws an error when drive access is denied
    });

  });

  describe('read_page', () => {
    it('has correct tool definition', () => {
      expect(pageReadTools.read_page).toBeDefined();
      expect(pageReadTools.read_page.description).toContain('Read');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when page not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'non-existent' },
          context
        )
      ).rejects.toThrow('Page with ID "non-existent" not found');
    });

    describe('line range support', () => {
      const tenLineContent = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage(tenLineContent));
        mockDb.query.taskItems = { findFirst: vi.fn().mockResolvedValue(null) };
        mockGetUserAccessLevel.mockResolvedValue('editor');
      });

      it('returns full content when no line params provided', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1' },
          createAuthContext()
        );

        assert({
          given: 'no lineStart or lineEnd params',
          should: 'return all 10 lines',
          actual: (result as { lineCount: number }).lineCount,
          expected: 10,
        });
      });

      it('returns lines in range when lineStart and lineEnd provided', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 3, lineEnd: 5 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=3 and lineEnd=5',
          should: 'return only lines 3-5',
          actual: (result as { content: string }).content,
          expected: '3→line3\n4→line4\n5→line5',
        });
      });

      it('returns from lineStart to end when only lineStart provided', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 8 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=8 with no lineEnd',
          should: 'return lines 8 through end',
          actual: (result as { content: string }).content,
          expected: '8→line8\n9→line9\n10→line10',
        });
      });

      it('returns from start to lineEnd when only lineEnd provided', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineEnd: 3 },
          createAuthContext()
        );

        assert({
          given: 'lineEnd=3 with no lineStart',
          should: 'return lines 1 through 3',
          actual: (result as { content: string }).content,
          expected: '1→line1\n2→line2\n3→line3',
        });
      });

      it('returns empty content with message when lineStart exceeds total lines', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 15 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=15 on a 10-line document',
          should: 'return empty content',
          actual: (result as { content: string }).content,
          expected: '',
        });

        assert({
          given: 'lineStart exceeds total lines',
          should: 'include message about range',
          actual: (result as { rangeMessage?: string }).rangeMessage,
          expected: 'Requested range (15-10) is beyond document length (10 lines)',
        });
      });

      it('clamps lineEnd to actual document length', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 8, lineEnd: 15 },
          createAuthContext()
        );

        assert({
          given: 'lineEnd=15 exceeding document length',
          should: 'return lines 8-10 (clamped)',
          actual: (result as { content: string }).content,
          expected: '8→line8\n9→line9\n10→line10',
        });
      });

      it('returns error when lineStart greater than lineEnd', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 5, lineEnd: 3 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=5 and lineEnd=3 (invalid range)',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });

        assert({
          given: 'invalid line range',
          should: 'include error message',
          actual: (result as { error?: string }).error,
          expected: 'Invalid line range: lineStart (5) cannot be greater than lineEnd (3)',
        });
      });

      it('returns error when lineStart is negative', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: -1 },
          createAuthContext()
        );

        assert({
          given: 'negative lineStart',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });

        assert({
          given: 'negative lineStart',
          should: 'include error message about valid range',
          actual: (result as { error?: string }).error,
          expected: 'Invalid line range: line numbers must be positive integers',
        });
      });

      it('returns error when lineEnd is negative', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineEnd: -5 },
          createAuthContext()
        );

        assert({
          given: 'negative lineEnd',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });
      });

      it('includes rangeStart and rangeEnd in response', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 3, lineEnd: 7 },
          createAuthContext()
        );

        assert({
          given: 'line range request',
          should: 'include rangeStart in response',
          actual: (result as { rangeStart?: number }).rangeStart,
          expected: 3,
        });

        assert({
          given: 'line range request',
          should: 'include rangeEnd in response',
          actual: (result as { rangeEnd?: number }).rangeEnd,
          expected: 7,
        });
      });

      it('includes totalLines in response for context', async () => {
        const result = await pageReadTools.read_page.execute!(
          { title: 'Test Page', pageId: 'page-1', lineStart: 3, lineEnd: 5 },
          createAuthContext()
        );

        assert({
          given: 'line range request',
          should: 'include totalLines for context',
          actual: (result as { totalLines?: number }).totalLines,
          expected: 10,
        });
      });
    });

  });

  describe('list_conversations', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'list_conversations tool',
        should: 'be defined',
        actual: pageReadTools.list_conversations !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.list_conversations.execute!(
          { pageId: 'page-1', title: 'Test Agent' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when page not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'non-existent', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'non-existent page',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when page is not AI_CHAT type', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('content', 'DOCUMENT'));
      mockGetUserAccessLevel.mockResolvedValue('editor');

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'page-1', title: 'Test Doc' },
        createAuthContext()
      );

      assert({
        given: 'a DOCUMENT page type',
        should: 'return error about invalid page type',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'a non-AI_CHAT page',
        should: 'include error message mentioning AI_CHAT',
        actual: (result as { error?: string }).error?.includes('AI_CHAT'),
        expected: true,
      });
    });

    it('returns error when user lacks permission', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue(null);

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'page-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'user without page access',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns empty array when AI_CHAT has no conversations', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue('editor');
      // Mock empty conversations query
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'page-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'AI_CHAT with no conversations',
        should: 'return success with empty array',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'AI_CHAT with no conversations',
        should: 'return empty conversations array',
        actual: (result as { conversations: unknown[] }).conversations,
        expected: [],
      });
    });

    it('returns conversation list with metadata', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue('editor');

      // Mock the main select for conversation aggregation
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([
              {
                conversationId: 'conv-1',
                messageCount: 5,
                lastActivity: new Date('2025-01-15'),
              },
              {
                conversationId: 'conv-2',
                messageCount: 10,
                lastActivity: new Date('2025-01-20'),
              },
            ]),
          }),
        }),
      });

      // Mock the chatMessages.findFirst for getting first message preview
      mockDb.query.chatMessages = {
        findFirst: vi.fn().mockResolvedValue({
          content: 'Hello, how can I help?',
          role: 'user',
          userId: 'user-1',
        }),
      };

      // Mock selectDistinct for participants
      (mockDb.selectDistinct as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { userId: 'user-1' },
          ]),
        }),
      });

      const result = await pageReadTools.list_conversations.execute!(
        { pageId: 'page-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'AI_CHAT with 2 conversations',
        should: 'return 2 conversations',
        actual: (result as { conversations: unknown[] }).conversations.length,
        expected: 2,
      });

      assert({
        given: 'a conversation in results',
        should: 'include conversationId',
        actual: typeof (result as { conversations: { conversationId: string }[] }).conversations[0].conversationId,
        expected: 'string',
      });

      assert({
        given: 'a conversation in results',
        should: 'include messageCount',
        actual: typeof (result as { conversations: { messageCount: number }[] }).conversations[0].messageCount,
        expected: 'number',
      });
    });
  });

  describe('read_conversation', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'read_conversation tool',
        should: 'be defined',
        actual: pageReadTools.read_conversation !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when page not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(null);

      const result = await pageReadTools.read_conversation.execute!(
        { pageId: 'non-existent', conversationId: 'conv-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'non-existent page',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when user lacks permission', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue(null);

      const result = await pageReadTools.read_conversation.execute!(
        { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'user without page access',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when conversation not found', async () => {
      mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
      mockGetUserAccessLevel.mockResolvedValue('editor');
      // Mock empty messages for this conversation
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await pageReadTools.read_conversation.execute!(
        { pageId: 'page-1', conversationId: 'non-existent', title: 'Test Agent' },
        createAuthContext()
      );

      assert({
        given: 'non-existent conversation',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'non-existent conversation',
        should: 'include error message',
        actual: (result as { error?: string }).error?.includes('not found'),
        expected: true,
      });
    });

    describe('message formatting', () => {
      const mockMessages = [
        { id: 'm1', role: 'user', content: 'Hello there', userId: 'user-1', sourceAgentId: null, createdAt: new Date('2025-01-15T10:00:00') },
        { id: 'm2', role: 'assistant', content: 'Hi! How can I help?', userId: null, sourceAgentId: null, createdAt: new Date('2025-01-15T10:01:00') },
        { id: 'm3', role: 'user', content: 'Check other agent', userId: 'user-1', sourceAgentId: 'global-assistant-id', createdAt: new Date('2025-01-15T10:02:00') },
      ];

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn()
          .mockResolvedValueOnce(createMockPage('', 'AI_CHAT')) // Main page lookup
          .mockResolvedValue({ id: 'global-assistant-id', title: 'Global Assistant' }); // Source agent lookup
        mockGetUserAccessLevel.mockResolvedValue('editor');
        (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(mockMessages),
            }),
          }),
        });
      });

      it('returns all messages when no line params', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          createAuthContext()
        );

        assert({
          given: 'a conversation with 3 messages',
          should: 'return messageCount of 3',
          actual: (result as { messageCount: number }).messageCount,
          expected: 3,
        });
      });

      it('formats direct user message with [user] prefix', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          createAuthContext()
        );

        assert({
          given: 'a direct user message',
          should: 'include [user] prefix in content',
          actual: (result as { content: string }).content.includes('[user]'),
          expected: true,
        });
      });

      it('formats assistant message with [assistant] prefix', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          createAuthContext()
        );

        assert({
          given: 'an assistant message',
          should: 'include [assistant] prefix in content',
          actual: (result as { content: string }).content.includes('[assistant]'),
          expected: true,
        });
      });

      it('formats message via another agent with [user@AgentName] prefix', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent' },
          createAuthContext()
        );

        assert({
          given: 'a message sent via Global Assistant',
          should: 'include [user@Global Assistant] prefix',
          actual: (result as { content: string }).content.includes('[user@Global Assistant]'),
          expected: true,
        });
      });
    });

    describe('line range support', () => {
      const fiveMessages = [
        { id: 'm1', role: 'user', content: 'Message 1', userId: 'u1', sourceAgentId: null, createdAt: new Date('2025-01-15T10:00:00') },
        { id: 'm2', role: 'assistant', content: 'Message 2', userId: null, sourceAgentId: null, createdAt: new Date('2025-01-15T10:01:00') },
        { id: 'm3', role: 'user', content: 'Message 3', userId: 'u1', sourceAgentId: null, createdAt: new Date('2025-01-15T10:02:00') },
        { id: 'm4', role: 'assistant', content: 'Message 4', userId: null, sourceAgentId: null, createdAt: new Date('2025-01-15T10:03:00') },
        { id: 'm5', role: 'user', content: 'Message 5', userId: 'u1', sourceAgentId: null, createdAt: new Date('2025-01-15T10:04:00') },
      ];

      beforeEach(() => {
        mockDb.query.pages.findFirst = vi.fn().mockResolvedValue(createMockPage('', 'AI_CHAT'));
        mockGetUserAccessLevel.mockResolvedValue('editor');
        (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(fiveMessages),
            }),
          }),
        });
      });

      it('returns only messages in range when lineStart and lineEnd provided', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent', lineStart: 2, lineEnd: 4 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=2 and lineEnd=4',
          should: 'return 3 messages',
          actual: (result as { content: string }).content.split('\n').length,
          expected: 3,
        });

        assert({
          given: 'lineStart=2 and lineEnd=4',
          should: 'include rangeStart in response',
          actual: (result as { rangeStart: number }).rangeStart,
          expected: 2,
        });

        assert({
          given: 'lineStart=2 and lineEnd=4',
          should: 'include rangeEnd in response',
          actual: (result as { rangeEnd: number }).rangeEnd,
          expected: 4,
        });
      });

      it('includes totalMessages in response', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent', lineStart: 2, lineEnd: 3 },
          createAuthContext()
        );

        assert({
          given: 'line range request',
          should: 'include totalMessages for context',
          actual: (result as { totalMessages: number }).totalMessages,
          expected: 5,
        });
      });

      it('returns empty with message when lineStart exceeds total', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent', lineStart: 10 },
          createAuthContext()
        );

        assert({
          given: 'lineStart=10 on a 5-message conversation',
          should: 'return empty content',
          actual: (result as { content: string }).content,
          expected: '',
        });

        assert({
          given: 'lineStart exceeds total',
          should: 'include rangeMessage',
          actual: (result as { rangeMessage?: string }).rangeMessage !== undefined,
          expected: true,
        });
      });

      it('returns error for invalid range (lineStart > lineEnd)', async () => {
        const result = await pageReadTools.read_conversation.execute!(
          { pageId: 'page-1', conversationId: 'conv-1', title: 'Test Agent', lineStart: 4, lineEnd: 2 },
          createAuthContext()
        );

        assert({
          given: 'lineStart > lineEnd',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });
      });
    });
  });
});
