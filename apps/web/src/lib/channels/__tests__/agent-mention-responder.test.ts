import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
      channelMessages: { findMany: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed' },
}));
vi.mock('@pagespace/db/schema/chat', () => ({
  channelMessages: { pageId: 'pageId', isActive: 'isActive', createdAt: 'createdAt' },
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

const mockInsertChannelThreadReply = vi.fn();
const mockLoadChannelMessageWithRelations = vi.fn();
const mockListChannelThreadFollowers = vi.fn();
vi.mock('@pagespace/lib/services/channel-message-repository', () => ({
  channelMessageRepository: {
    insertChannelThreadReply: (...args: unknown[]) => mockInsertChannelThreadReply(...args),
    loadChannelMessageWithRelations: (...args: unknown[]) => mockLoadChannelMessageWithRelations(...args),
    listChannelThreadFollowers: (...args: unknown[]) => mockListChannelThreadFollowers(...args),
  },
}));

vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ 'x-signed': 'yes' })),
}));

const mockBroadcastInboxEvent = vi.fn();
const mockBroadcastThreadReplyCountUpdated = vi.fn();
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: (...args: unknown[]) => mockBroadcastInboxEvent(...args),
  broadcastThreadReplyCountUpdated: (...args: unknown[]) => mockBroadcastThreadReplyCountUpdated(...args),
}));

import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { agentCommunicationTools } from '@/lib/ai/tools/agent-communication-tools';
import { channelTools } from '@/lib/ai/tools/channel-tools';
import {
  isAskAgentResult,
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
    mockInsertChannelThreadReply.mockResolvedValue({
      kind: 'ok',
      reply: { id: 'agent-reply-1', createdAt: new Date('2026-05-05T12:00:00Z') },
      mirror: null,
      rootId: 'parent-thread',
      replyCount: 2,
      lastReplyAt: new Date('2026-05-05T12:00:00Z'),
    });
    mockLoadChannelMessageWithRelations.mockResolvedValue({
      id: 'agent-reply-1',
      parentId: 'parent-thread',
      createdAt: new Date('2026-05-05T12:00:00Z').toISOString(),
    });
    mockListChannelThreadFollowers.mockResolvedValue([]);
    mockBroadcastInboxEvent.mockResolvedValue(undefined);
    mockBroadcastThreadReplyCountUpdated.mockResolvedValue(undefined);
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

  it('given parentId is set, routes the agent reply via insertChannelThreadReply with aiMeta', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockAskAgentExecute.mockResolvedValue(
      createAskAgentSuccess('In-thread reply')
    );

    await triggerMentionedAgentResponses({
      ...baseParams,
      sourceMessageId: 'thread-reply-1',
      parentId: 'parent-thread',
      content: 'Hey @[Budget Agent](agent-1:page) what do you think?',
    });

    expect(mockInsertChannelThreadReply).toHaveBeenCalledTimes(1);
    const insertArgs = mockInsertChannelThreadReply.mock.calls[0][0];
    expect(insertArgs.parentId).toBe('parent-thread');
    expect(insertArgs.pageId).toBe('channel-1');
    expect(insertArgs.userId).toBe('user-1');
    expect(insertArgs.content).toBe('In-thread reply');
    expect(insertArgs.aiMeta).toEqual({
      senderType: 'agent',
      senderName: 'Budget Agent',
      agentPageId: 'agent-1',
    });

    // Top-level path must NOT fire when parentId is set.
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
    // Parent footer refresh must fire so the channel-stream view updates.
    expect(mockBroadcastThreadReplyCountUpdated).toHaveBeenCalledWith(
      'channel-1',
      expect.objectContaining({ rootId: 'parent-thread' })
    );
  });

  it('given parentId is set, fans out thread_updated to followers excluding the human user', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockListChannelThreadFollowers.mockResolvedValue(['user-1', 'user-other', 'user-third']);

    await triggerMentionedAgentResponses({
      ...baseParams,
      parentId: 'parent-thread',
      content: 'Reply @[Budget Agent](agent-1:page)',
    });

    const recipients = mockBroadcastInboxEvent.mock.calls
      .filter(([, payload]) => (payload as { operation: string }).operation === 'thread_updated')
      .map(([userId]) => userId);
    expect(recipients).toEqual(expect.arrayContaining(['user-other', 'user-third']));
    expect(recipients).not.toContain('user-1');
  });

  it('given parentId is empty, falls back to the existing top-level send path', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      parentId: '',
      content: 'Reply @[Budget Agent](agent-1:page)',
    });

    expect(mockInsertChannelThreadReply).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
  });

  it('given askAgentExecute returns a malformed value, persists nothing and skips the agent reply', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);
    // Boundary mock: simulate a future tool-shape change that no longer matches AskAgentResult.
    mockAskAgentExecute.mockResolvedValueOnce({ unexpected: 'shape' });

    await triggerMentionedAgentResponses({
      ...baseParams,
      parentId: 'parent-thread',
      content: 'Reply @[Budget Agent](agent-1:page)',
    });

    expect(mockInsertChannelThreadReply).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
    expect(mockBroadcastInboxEvent).not.toHaveBeenCalled();
  });
});

describe('isAskAgentResult', () => {
  it('accepts the canonical success shape', () => {
    expect(
      isAskAgentResult({ success: true, response: 'hi', error: undefined })
    ).toBe(true);
  });

  it('accepts a partial shape where only success is present', () => {
    expect(isAskAgentResult({ success: false })).toBe(true);
  });

  it('accepts a partial shape where only error is present', () => {
    expect(isAskAgentResult({ error: 'boom' })).toBe(true);
  });

  it('rejects an empty object — no recognizable AskAgentResult fields', () => {
    expect(isAskAgentResult({})).toBe(false);
  });

  it('rejects null', () => {
    expect(isAskAgentResult(null)).toBe(false);
  });

  it('rejects non-object primitives', () => {
    expect(isAskAgentResult('ok')).toBe(false);
    expect(isAskAgentResult(42)).toBe(false);
    expect(isAskAgentResult(undefined)).toBe(false);
  });

  it('rejects when success is present but not boolean', () => {
    expect(isAskAgentResult({ success: 'true' })).toBe(false);
  });

  it('rejects when response is present but not string', () => {
    expect(isAskAgentResult({ success: true, response: 42 })).toBe(false);
  });

  it('rejects when error is present but not string', () => {
    expect(isAskAgentResult({ success: false, error: { msg: 'x' } })).toBe(false);
  });
});
