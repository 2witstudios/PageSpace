/**
 * A mention reply runs the mentioned agent's model and bills the MENTIONER
 * (executeAskAgent → AIMonitoring.trackUsage). That spend must pass the credit
 * gate before the model runs: an exhausted balance gets no agent reply and no
 * charge, a funded one gets its reply and the hold is released exactly once.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const { mockCanConsumeAI, mockReleaseHold, mockSelectWhere } = vi.hoisted(() => ({
  mockCanConsumeAI: vi.fn(),
  mockReleaseHold: vi.fn(),
  mockSelectWhere: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockSelectWhere })) })),
    query: {
      pages: { findMany: vi.fn() },
      channelMessages: { findMany: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', async (importOriginal) => ({
  // Keep the real re-exports so transitively imported lib modules (e.g.
  // sheets/search-sql via services/preview) that use `sql` still load.
  ...(await importOriginal<typeof import('@pagespace/db/operators')>()),
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

// The two gates added for member agents (see agent-mention-responder.ts):
// membership in the channel's drive is the grant when the mentioner cannot
// view the agent's home page, and the agent must be able to post in the
// channel BEFORE any model call is spent on it.
vi.mock('@pagespace/lib/permissions/agent-permissions', () => ({
  hasAgentDriveMembership: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/ai/tools/actor-permissions', () => ({
  canActorEditPage: vi.fn().mockResolvedValue(true),
  canActorConsultAgent: vi.fn().mockResolvedValue(true),
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

vi.mock('@/lib/commands/help-answer', () => ({
  loadHelpAnswerText: vi.fn(async () => 'help text'),
}));

vi.mock('@/lib/ai/tools/agent-communication-tools', () => ({
  executeAskAgent: vi.fn(),
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

const mockNotifyMentionedUsers = vi.fn();
vi.mock('@/lib/channels/notify-mentioned-users', () => ({
  notifyMentionedUsers: (...args: unknown[]) => mockNotifyMentionedUsers(...args),
}));

const mockBroadcastInboxEvent = vi.fn();
const mockBroadcastThreadReplyCountUpdated = vi.fn();
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: (...args: unknown[]) => mockBroadcastInboxEvent(...args),
  broadcastThreadReplyCountUpdated: (...args: unknown[]) => mockBroadcastThreadReplyCountUpdated(...args),
}));

import { db } from '@pagespace/db/db';
import { executeAskAgent } from '@/lib/ai/tools/agent-communication-tools';
import { channelTools } from '@/lib/ai/tools/channel-tools';
import { triggerMentionedAgentResponses } from '../agent-mention-responder';

const mockPagesFindMany = db.query.pages.findMany as unknown as Mock;
const mockChannelMessagesFindMany = db.query.channelMessages.findMany as unknown as Mock;
const mockAskAgentExecute = executeAskAgent as unknown as Mock;
const mockSendChannelExecute = channelTools.send_channel_message.execute as unknown as Mock;

const params = {
  userId: 'user-1',
  channelId: 'channel-1',
  channelTitle: 'General',
  channelType: 'CHANNEL' as const,
  sourceMessageId: 'msg-1',
  content: 'What now @[Budget Agent](agent-1:page)',
  driveId: 'drive-1',
  driveName: 'Workspace',
  driveSlug: 'workspace',
};

describe('agent-mention-responder credit gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectWhere.mockResolvedValue([{ subscriptionTier: 'free' }]);
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockChannelMessagesFindMany.mockResolvedValue([]);
    mockAskAgentExecute.mockResolvedValue({ success: true, response: 'Agent reply', agent: 'Budget Agent' });
    mockSendChannelExecute.mockResolvedValue({ success: true });
    mockReleaseHold.mockResolvedValue(undefined);
  });

  it('given the mentioner has an exhausted balance, should not run the agent or post a reply', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

    await triggerMentionedAgentResponses(params);

    expect(mockCanConsumeAI).toHaveBeenCalledWith('user-1', 'free', expect.any(Object));
    expect(mockAskAgentExecute).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).not.toHaveBeenCalled();
    expect(mockReleaseHold).not.toHaveBeenCalled();
  });

  it('given a funded mentioner, should run the agent, post its reply and release the hold once', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1' });

    await triggerMentionedAgentResponses(params);

    expect(mockCanConsumeAI).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
  });

  it('given the agent run throws, should still release the hold exactly once', async () => {
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-2' });
    mockAskAgentExecute.mockRejectedValue(new Error('provider down'));

    await triggerMentionedAgentResponses(params);

    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-2');
  });

  it('given two mentioned agents, should gate and hold each reply on its own', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Budget Agent', enabledTools: ['send_channel_message'] },
      { id: 'agent-2', title: 'Ops Agent', enabledTools: ['send_channel_message'] },
    ]);
    mockCanConsumeAI
      .mockResolvedValueOnce({ allowed: true, reason: 'ok', holdId: 'hold-a' })
      .mockResolvedValueOnce({ allowed: false, reason: 'out_of_credits' });

    await triggerMentionedAgentResponses({
      ...params,
      content: '@[Budget Agent](agent-1:page) and @[Ops Agent](agent-2:page)',
    });

    expect(mockCanConsumeAI).toHaveBeenCalledTimes(2);
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    expect(mockAskAgentExecute.mock.calls[0][0].agentId).toBe('agent-1');
    expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-a');
  });

  it('given a solo /help mention, should answer from code without gating', async () => {
    await triggerMentionedAgentResponses({
      ...params,
      content: '@[Budget Agent](agent-1:page) /[help](builtin:help:command)',
    });

    expect(mockCanConsumeAI).not.toHaveBeenCalled();
    expect(mockAskAgentExecute).not.toHaveBeenCalled();
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
  });
});
