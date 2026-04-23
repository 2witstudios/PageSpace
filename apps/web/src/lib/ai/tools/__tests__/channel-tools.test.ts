import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

/**
 * Channel Tools Tests
 *
 * Tests for the send_channel_message AI tool that allows LLMs to post
 * messages in channels. Covers authentication, permission checks,
 * channel validation, and sender identity (global assistant vs page agent).
 */

// Mock database
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      channelMessages: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
      driveMembers: { findMany: vi.fn() },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'msg-1' }]),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
  channelMessages: {},
  channelReadStatus: { userId: 'userId', channelId: 'channelId' },
  driveMembers: { driveId: 'driveId' },
  pages: { id: 'id', isTrashed: 'isTrashed' },
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions', () => ({
  canUserEditPage: vi.fn(),
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  getActorInfo: vi.fn().mockResolvedValue({
    actorEmail: 'test@example.com',
    actorDisplayName: 'Test User',
  }),
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

vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({
    'Content-Type': 'application/json',
  })),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(),
}));

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

import { channelTools } from '../channel-tools';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/permissions';
import { getActorInfo } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';
import type { ToolExecutionContext } from '../../core';

const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockCanUserViewPage = vi.mocked(canUserViewPage);
const mockGetActorInfo = vi.mocked(getActorInfo);
const mockBroadcastInboxEvent = vi.mocked(broadcastInboxEvent);
const mockDbInsert = db.insert as unknown as Mock;
const mockPagesFindFirst = db.query.pages.findFirst as unknown as Mock;
const mockChannelMessagesFindFirst = db.query.channelMessages.findFirst as unknown as Mock;
const mockDriveMembersFindMany = db.query.driveMembers.findMany as unknown as Mock;

// Helper to safely extract result from tool execution (handles AsyncIterable union)
type ToolResult = Record<string, unknown>;
const executeToolAs = async (
  args: { channelId: string; content: string },
  context: Parameters<NonNullable<typeof channelTools.send_channel_message.execute>>[1]
) =>
  channelTools.send_channel_message.execute!(args, context) as unknown as Promise<ToolResult>;

describe('channel-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActorInfo.mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
    mockCanUserViewPage.mockResolvedValue(true);
    mockChannelMessagesFindFirst.mockResolvedValue({
      id: 'msg-1',
      createdAt: new Date('2026-02-10T12:00:00.000Z'),
      user: { id: 'user-123', name: 'Alice', image: null },
      file: null,
      reactions: [],
    });
    mockDriveMembersFindMany.mockResolvedValue([]);
    mockBroadcastInboxEvent.mockResolvedValue(undefined);
  });

  describe('send_channel_message', () => {
    it('has correct tool definition', () => {
      expect(channelTools.send_channel_message).toBeDefined();
      expect(channelTools.send_channel_message.description).toContain('channel');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        channelTools.send_channel_message.execute!(
          { channelId: 'ch-1', content: 'Hello' },
          context
        )
      ).rejects.toThrow('User authentication required');
    });

    it('throws error when channel not found', async () => {
      mockPagesFindFirst.mockResolvedValue(null);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        channelTools.send_channel_message.execute!(
          { channelId: 'non-existent', content: 'Hello' },
          context
        )
      ).rejects.toThrow('Channel with ID "non-existent" not found');

      expect(mockPagesFindFirst).toHaveBeenCalled();
    });

    it('returns error when page is not a CHANNEL type', async () => {
      mockPagesFindFirst.mockResolvedValue({
        id: 'page-1',
        title: 'A Document',
        type: 'DOCUMENT',
        content: '',
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      const result = await executeToolAs(
        { channelId: 'page-1', content: 'Hello' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Page is not a channel');
    });

    it('throws error when user lacks edit permission', async () => {
      mockPagesFindFirst.mockResolvedValue({
        id: 'ch-1',
        title: 'General',
        type: 'CHANNEL',
        content: '',
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(false);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        channelTools.send_channel_message.execute!(
          { channelId: 'ch-1', content: 'Hello' },
          context
        )
      ).rejects.toThrow('Insufficient permissions to send messages in this channel');
    });

    it('sends message as global assistant with user name', async () => {
      mockPagesFindFirst.mockResolvedValue({
        id: 'ch-1',
        title: 'General',
        type: 'CHANNEL',
        content: '',
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockGetActorInfo.mockResolvedValue({
        actorEmail: 'alice@example.com',
        actorDisplayName: 'Alice',
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          chatSource: { type: 'global' },
        } as ToolExecutionContext,
      };

      const result = await executeToolAs(
        { channelId: 'ch-1', content: 'Hello from assistant' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.senderName).toBe('Alice');
      expect(result.senderType).toBe('global_assistant');
      expect(result.messagePreview).toBe('Hello from assistant');
    });

    it('sends message as page agent with agent + user display name', async () => {
      mockPagesFindFirst.mockResolvedValue({
        id: 'ch-1',
        title: 'General',
        type: 'CHANNEL',
        content: '',
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          chatSource: {
            type: 'page',
            agentPageId: 'agent-1',
            agentTitle: 'Budget Analyst',
          },
        } as ToolExecutionContext,
      };

      const result = await executeToolAs(
        { channelId: 'ch-1', content: 'Budget report ready' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.senderName).toBe('Budget Analyst (Test User)');
      expect(result.senderType).toBe('agent');
    });

    it('marks global assistant messages as read and skips sender inbox broadcast', async () => {
      mockPagesFindFirst.mockResolvedValue({
        id: 'ch-1',
        title: 'General',
        type: 'CHANNEL',
        driveId: 'drive-1',
        drive: { ownerId: 'user-456' },
      });
      mockDriveMembersFindMany.mockResolvedValue([
        { userId: 'user-123' },
        { userId: 'user-456' },
      ]);
      mockCanUserEditPage.mockResolvedValue(true);
      mockGetActorInfo.mockResolvedValue({
        actorEmail: 'alice@example.com',
        actorDisplayName: 'Alice',
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          chatSource: { type: 'global' },
        } as ToolExecutionContext,
      };

      const result = await executeToolAs(
        { channelId: 'ch-1', content: 'Global update' },
        context
      );

      expect(result.success).toBe(true);
      expect(mockDbInsert).toHaveBeenCalledTimes(2);
      expect(mockBroadcastInboxEvent).toHaveBeenCalledTimes(1);
      expect(mockBroadcastInboxEvent).toHaveBeenCalledWith(
        'user-456',
        expect.objectContaining({
          operation: 'channel_updated',
          id: 'ch-1',
        })
      );
    });

    it('keeps agent messages unread for requester and includes requester in inbox broadcast', async () => {
      mockPagesFindFirst.mockResolvedValue({
        id: 'ch-1',
        title: 'General',
        type: 'CHANNEL',
        driveId: 'drive-1',
        drive: { ownerId: 'user-456' },
      });
      mockDriveMembersFindMany.mockResolvedValue([
        { userId: 'user-123' },
        { userId: 'user-456' },
      ]);
      mockCanUserEditPage.mockResolvedValue(true);

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
          chatSource: {
            type: 'page',
            agentPageId: 'agent-1',
            agentTitle: 'Budget Analyst',
          },
        } as ToolExecutionContext,
      };

      const result = await executeToolAs(
        { channelId: 'ch-1', content: 'Agent follow-up' },
        context
      );

      expect(result.success).toBe(true);
      expect(mockDbInsert).toHaveBeenCalledTimes(1);
      expect(mockBroadcastInboxEvent).toHaveBeenCalledTimes(2);

      const recipients = mockBroadcastInboxEvent.mock.calls.map(([recipient]) => recipient);
      expect(recipients).toContain('user-123');
      expect(recipients).toContain('user-456');
    });

    it('defaults to global_assistant when chatSource is not provided', async () => {
      mockPagesFindFirst.mockResolvedValue({
        id: 'ch-1',
        title: 'General',
        type: 'CHANNEL',
        content: '',
        driveId: 'drive-1',
        parentId: null,
        position: 1,
        isTrashed: false,
        trashedAt: null,
        revision: 1,
        stateHash: null,
      });
      mockCanUserEditPage.mockResolvedValue(true);
      mockGetActorInfo.mockResolvedValue({
        actorEmail: 'bob@example.com',
        actorDisplayName: 'Bob',
      });

      const context = {
        toolCallId: '1', messages: [],
        experimental_context: {
          userId: 'user-123',
        } as ToolExecutionContext,
      };

      const result = await executeToolAs(
        { channelId: 'ch-1', content: 'Hello' },
        context
      );

      expect(result.success).toBe(true);
      expect(result.senderType).toBe('global_assistant');
      expect(result.senderName).toBe('Bob');
    });

    it('rejects empty message content', async () => {
      const context = {
        toolCallId: '1', messages: [],
        experimental_context: { userId: 'user-123' } as ToolExecutionContext,
      };

      await expect(
        channelTools.send_channel_message.execute!(
          { channelId: 'ch-1', content: '' },
          context
        )
      ).rejects.toThrow('Message content cannot be empty');
    });
  });
});
