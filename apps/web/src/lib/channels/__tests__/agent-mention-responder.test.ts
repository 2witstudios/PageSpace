import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
      channelMessages: { findMany: vi.fn() },
    },
  },
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed' },
  channelMessages: { pageId: 'pageId', isActive: 'isActive', createdAt: 'createdAt' },
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    ai: {
      child: vi.fn(() => ({
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
  },
}));

vi.mock('@/lib/ai/tools/agent-communication-tools', () => ({
  agentCommunicationTools: {
    ask_agent: {
      execute: vi.fn(),
    },
  },
}));

vi.mock('@/lib/ai/tools/channel-tools', () => ({
  channelTools: {
    send_channel_message: {
      execute: vi.fn(),
    },
  },
}));

import { db } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { agentCommunicationTools } from '@/lib/ai/tools/agent-communication-tools';
import { channelTools } from '@/lib/ai/tools/channel-tools';
import {
  triggerMentionedAgentResponses,
  type TriggerMentionedAgentResponsesParams,
} from '../agent-mention-responder';

const mockPagesFindMany = vi.mocked(db.query.pages.findMany);
const mockChannelMessagesFindMany = vi.mocked(db.query.channelMessages.findMany);
const mockCanUserViewPage = vi.mocked(canUserViewPage);
const mockAskAgentExecute = vi.mocked(agentCommunicationTools.ask_agent.execute);
const mockSendChannelExecute = vi.mocked(channelTools.send_channel_message.execute);

const baseParams: TriggerMentionedAgentResponsesParams = {
  userId: 'user-1',
  channelId: 'channel-1',
  channelTitle: 'General',
  channelType: 'CHANNEL',
  sourceMessageId: 'msg-1',
  content: 'Hello',
  driveId: 'drive-1',
  driveName: 'Workspace',
  driveSlug: 'workspace',
};

describe('agent-mention-responder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPagesFindMany.mockResolvedValue([]);
    mockChannelMessagesFindMany.mockResolvedValue([]);
    mockCanUserViewPage.mockResolvedValue(true);
    mockAskAgentExecute.mockResolvedValue({
      success: true,
      response: 'Agent reply',
    });
    mockSendChannelExecute.mockResolvedValue({
      success: true,
    });
  });

  it('does nothing when no structured mentions are present', async () => {
    await triggerMentionedAgentResponses({
      ...baseParams,
      content: 'No mentions here',
    });

    expect(mockPagesFindMany).not.toHaveBeenCalled();
    expect(mockAskAgentExecute).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
  });

  it('consults and posts response for mentioned AI agent', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockChannelMessagesFindMany.mockResolvedValue([
      {
        content: 'Earlier thread context',
        createdAt: new Date('2026-02-10T09:00:00.000Z'),
        aiMeta: null,
        user: { name: 'Alice' },
      },
    ]);
    mockAskAgentExecute.mockResolvedValue({
      success: true,
      response: 'I think this conversation is on track.',
    });

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: 'What do you think of this convo @[Budget Agent](agent-1:page)',
    });

    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        conversationId: 'channel:channel-1:agent:agent-1',
      }),
      expect.objectContaining({
        experimental_context: expect.objectContaining({
          userId: 'user-1',
          locationContext: expect.objectContaining({
            currentPage: expect.objectContaining({
              id: 'channel-1',
            }),
          }),
        }),
      })
    );

    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
    expect(mockSendChannelExecute).toHaveBeenCalledWith(
      {
        channelId: 'channel-1',
        content: 'I think this conversation is on track.',
      },
      expect.objectContaining({
        experimental_context: expect.objectContaining({
          chatSource: {
            type: 'page',
            agentPageId: 'agent-1',
            agentTitle: 'Budget Agent',
          },
        }),
      })
    );
  });

  it('skips when structured mention does not resolve to an active AI agent', async () => {
    mockPagesFindMany.mockResolvedValue([]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: 'Check this @[Regular Page](page-123:page)',
    });

    expect(mockPagesFindMany).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
  });

  it('deduplicates repeated mentions and skips agents without view access', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
      { id: 'agent-2', title: 'Ops Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockCanUserViewPage.mockImplementation(async (_userId, pageId) => pageId === 'agent-1');

    await triggerMentionedAgentResponses({
      ...baseParams,
      content:
        'Ping @[Budget Agent](agent-1:page) and @[Budget Agent](agent-1:page) and @[Ops Agent](agent-2:page)',
    });

    expect(mockCanUserViewPage).toHaveBeenCalledTimes(2);
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1' }),
      expect.any(Object)
    );
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
  });

  it('does not post when ask_agent returns failure', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockAskAgentExecute.mockResolvedValue({
      success: false,
      error: 'Agent failed',
    });

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: 'Need input @[Budget Agent](agent-1:page)',
    });

    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
  });

  it('skips agent replies when send_channel_message is not enabled', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['list_pages'] },
    ]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: 'Need input @[Budget Agent](agent-1:page)',
    });

    expect(mockAskAgentExecute).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
  });
});
