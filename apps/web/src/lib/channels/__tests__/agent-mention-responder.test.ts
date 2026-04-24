import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

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

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserViewPage: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    ai: {
      debug: vi.fn(),
      child: vi.fn(() => ({
        warn: vi.fn(),
        error: vi.fn(),
      
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
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
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { agentCommunicationTools } from '@/lib/ai/tools/agent-communication-tools';
import { channelTools } from '@/lib/ai/tools/channel-tools';
import {
  triggerMentionedAgentResponses,
  type TriggerMentionedAgentResponsesParams,
} from '../agent-mention-responder';

const mockPagesFindMany = db.query.pages.findMany as unknown as Mock;
const mockChannelMessagesFindMany = db.query.channelMessages.findMany as unknown as Mock;
const mockCanUserViewPage = vi.mocked(canUserViewPage);

const askAgentExecute = agentCommunicationTools.ask_agent.execute;
const sendChannelExecute = channelTools.send_channel_message.execute;

if (!askAgentExecute || !sendChannelExecute) {
  throw new Error('Agent mention responder tool mocks are unavailable');
}

const mockAskAgentExecute = askAgentExecute as unknown as Mock;
const mockSendChannelExecute = sendChannelExecute as unknown as Mock;

const createAskAgentSuccess = (response: string) => ({
  success: true,
  agent: 'Budget Agent',
  agentPath: '/Budget Agent',
  question: 'What do you think?',
  response,
  context: undefined,
  conversationId: 'channel:channel-1:agent:agent-1',
  metadata: {
    agentId: 'agent-1',
    processingTime: 42,
    persistent: true,
    isNewConversation: false,
    callDepth: 1,
    provider: 'PageSpace',
    model: 'Default (Free)',
    toolsEnabled: 1,
    toolCalls: 0,
    steps: 1,
  },
});

const createAskAgentFailure = (error: string) => ({
  success: false,
  agent: '/Budget Agent',
  error,
  question: 'What do you think?',
  context: undefined,
  metadata: {
    processingTime: 42,
    callDepth: 1,
  },
});

const createSendChannelSuccess = () => ({
  success: true,
  messageId: 'msg-agent-1',
  channelId: 'channel-1',
  channelTitle: 'General',
  senderName: 'Budget Agent (Alice)',
  senderType: 'agent' as const,
  messagePreview: 'Agent reply',
  message: 'Successfully sent message to channel "General"',
  summary: 'Posted to #General as Budget Agent (Alice) (agent)',
});

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
    mockAskAgentExecute.mockResolvedValue(createAskAgentSuccess('Agent reply'));
    mockSendChannelExecute.mockResolvedValue(createSendChannelSuccess());
  });

  it('given message with no mentions, should not query agents or post responses', async () => {
    await triggerMentionedAgentResponses({
      ...baseParams,
      content: 'No mentions here',
    });

    expect(mockPagesFindMany).not.toHaveBeenCalled();
    expect(mockAskAgentExecute).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
  });

  it('given message mentioning an AI agent, should consult agent and post response to channel', async () => {
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
    mockAskAgentExecute.mockResolvedValue(
      createAskAgentSuccess('I think this conversation is on track.')
    );

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: 'What do you think of this convo @[Budget Agent](agent-1:page)',
    });

    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    const askArgs = mockAskAgentExecute.mock.calls[0];
    expect(askArgs[0].agentId).toBe('agent-1');
    expect(askArgs[0].conversationId).toBe('channel:channel-1:agent:agent-1');
    expect(askArgs[0].agentPath).toBe('/Budget Agent');
    const askContext = askArgs[1].experimental_context;
    expect(askContext.userId).toBe('user-1');
    expect(askContext.conversationId).toBe('channel:channel-1:agent:agent-1');
    expect(askContext.locationContext.currentPage.id).toBe('channel-1');
    expect(askContext.requestOrigin).toBe('user');

    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
    const sendArgs = mockSendChannelExecute.mock.calls[0];
    expect(sendArgs[0]).toEqual({
      channelId: 'channel-1',
      content: 'I think this conversation is on track.',
    });
    const sendContext = sendArgs[1].experimental_context;
    expect(sendContext.chatSource).toEqual({
      type: 'page',
      agentPageId: 'agent-1',
      agentTitle: 'Budget Agent',
    });
    expect(sendContext.requestOrigin).toBe('agent');
  });

  it('given mention of non-existent agent, should skip without consulting or posting', async () => {
    mockPagesFindMany.mockResolvedValue([]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: 'Check this @[Regular Page](page-123:page)',
    });

    expect(mockPagesFindMany).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
  });

  it('given repeated mentions of same agent, should deduplicate and consult only once', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content:
        'Ping @[Budget Agent](agent-1:page) and @[Budget Agent](agent-1:page)',
    });

    expect(mockCanUserViewPage).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute.mock.calls[0][0].agentId).toBe('agent-1');
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
  });

  it('given mention of agent user cannot view, should skip that agent', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
      { id: 'agent-2', title: 'Ops Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockCanUserViewPage.mockImplementation(async (_userId, pageId) => pageId === 'agent-1');

    await triggerMentionedAgentResponses({
      ...baseParams,
      content:
        '@[Budget Agent](agent-1:page) and @[Ops Agent](agent-2:page)',
    });

    expect(mockCanUserViewPage).toHaveBeenCalledTimes(2);
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute.mock.calls[0][0].agentId).toBe('agent-1');
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
  });

  it('does not post when ask_agent returns failure', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockAskAgentExecute.mockResolvedValue(createAskAgentFailure('Agent failed'));

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
