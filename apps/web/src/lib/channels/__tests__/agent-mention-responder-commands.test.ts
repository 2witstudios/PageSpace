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
vi.mock('@pagespace/lib/services/drive-agent-service', () => ({
  getAgentContextDrives: vi.fn().mockResolvedValue([]),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      debug: vi.fn(),
      child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
  },
}));
vi.mock('@/lib/ai/tools/agent-communication-tools', () => ({
  agentCommunicationTools: { ask_agent: { execute: vi.fn() } },
}));
vi.mock('@/lib/ai/tools/channel-tools', () => ({
  channelTools: { send_channel_message: { execute: vi.fn() } },
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
  createSignedBroadcastHeaders: vi.fn(() => ({})),
}));
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: vi.fn(),
  broadcastThreadReplyCountUpdated: vi.fn(),
}));
vi.mock('@pagespace/lib/services/preview', () => ({
  buildThreadPreview: vi.fn(() => 'preview'),
}));
vi.mock('@/lib/ai/core/command-resolver', () => ({
  planCommandExecutions: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { agentCommunicationTools } from '@/lib/ai/tools/agent-communication-tools';
import { channelTools } from '@/lib/ai/tools/channel-tools';
import { planCommandExecutions } from '@/lib/ai/core/command-resolver';
import type { CommandExecutionPlan } from '@/lib/ai/core/command-processor';
import { triggerMentionedAgentResponses } from '../agent-mention-responder';

const mockPagesFindMany = db.query.pages.findMany as unknown as Mock;
const mockChannelMessagesFindMany = db.query.channelMessages.findMany as unknown as Mock;
const mockCanUserViewPage = vi.mocked(canUserViewPage);
const mockPlanCommandExecutions = vi.mocked(planCommandExecutions);
const mockAskAgentExecute = agentCommunicationTools.ask_agent.execute as unknown as Mock;
const mockSendChannelExecute = channelTools.send_channel_message.execute as unknown as Mock;

const CMD_ID = 'tz4a98xxat96iws9zmbrgj3a';

const baseParams = {
  userId: 'user-1',
  channelId: 'channel-1',
  channelTitle: 'General',
  sourceMessageId: 'msg-1',
  content: `/[release-checklist](${CMD_ID}:command) @[Helper](agent-1:page) run it`,
};

const injectPlan: CommandExecutionPlan = {
  kind: 'inject',
  injection: {
    commandId: CMD_ID,
    trigger: 'release-checklist',
    label: 'release-checklist',
    scope: 'user',
    description: 'Run the release checklist.',
    entryPage: {
      id: 'entry-1',
      title: 'Release Checklist',
      type: 'DOCUMENT',
      serializedContent: 'Step 1: run tests',
    },
    children: [],
  },
};

const skipPlan: CommandExecutionPlan = {
  kind: 'skip',
  commandId: CMD_ID,
  label: 'release-checklist',
  reason: 'disabled',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPagesFindMany.mockResolvedValue([
    { id: 'agent-1', title: 'Helper', enabledTools: ['send_channel_message'] },
  ]);
  mockChannelMessagesFindMany.mockResolvedValue([]);
  mockCanUserViewPage.mockResolvedValue(true);
  mockAskAgentExecute.mockResolvedValue({ success: true, response: 'done' });
  mockSendChannelExecute.mockResolvedValue({ success: true });
  mockPlanCommandExecutions.mockResolvedValue([]);
});

describe('triggerMentionedAgentResponses — universal commands', () => {
  it("resolves the command with the SENDER's permissions and the channel's drive context", async () => {
    mockPlanCommandExecutions.mockResolvedValue([injectPlan]);
    await triggerMentionedAgentResponses({ ...baseParams, driveId: 'drive-1' });
    expect(mockPlanCommandExecutions).toHaveBeenCalledWith(baseParams.content, 'user-1', {
      driveId: 'drive-1',
    });
  });

  it('resolves with a null drive context when the channel has none', async () => {
    mockPlanCommandExecutions.mockResolvedValue([injectPlan]);
    await triggerMentionedAgentResponses(baseParams);
    expect(mockPlanCommandExecutions).toHaveBeenCalledWith(baseParams.content, 'user-1', {
      driveId: null,
    });
  });

  it('injects the command section into the agent ask context', async () => {
    mockPlanCommandExecutions.mockResolvedValue([injectPlan]);
    await triggerMentionedAgentResponses(baseParams);

    const askArgs = mockAskAgentExecute.mock.calls[0][0] as { context: string };
    expect(askArgs.context).toContain('Step 1: run tests');
    expect(askArgs.context).toContain('/release-checklist');
  });

  it('passes the skip notice into the ask context for a skipped command', async () => {
    mockPlanCommandExecutions.mockResolvedValue([skipPlan]);
    await triggerMentionedAgentResponses(baseParams);

    const askArgs = mockAskAgentExecute.mock.calls[0][0] as { context: string };
    expect(askArgs.context).toContain('the command is disabled');
  });

  it('adds nothing to the ask context when the message has no command', async () => {
    mockPlanCommandExecutions.mockResolvedValue([]);
    await triggerMentionedAgentResponses(baseParams);

    const askArgs = mockAskAgentExecute.mock.calls[0][0] as { context: string };
    expect(askArgs.context).not.toContain('COMMAND');
  });

  it('threads execution feedback into the top-level reply tool context', async () => {
    mockPlanCommandExecutions.mockResolvedValue([injectPlan]);
    await triggerMentionedAgentResponses(baseParams);

    const sendOptions = mockSendChannelExecute.mock.calls[0][1] as {
      experimental_context: { commandExecution?: unknown };
    };
    expect(sendOptions.experimental_context.commandExecution).toEqual([
      {
        label: 'release-checklist',
        status: 'used',
        entryPageTitle: 'Release Checklist',
      },
    ]);
  });

  it('attaches execution feedback to thread replies via aiMeta', async () => {
    mockPlanCommandExecutions.mockResolvedValue([skipPlan]);
    mockInsertChannelThreadReply.mockResolvedValue({
      kind: 'ok',
      reply: { id: 'reply-1' },
      rootId: 'root-1',
      replyCount: 1,
      lastReplyAt: new Date('2026-06-10T00:00:00Z'),
    });
    mockLoadChannelMessageWithRelations.mockResolvedValue(null);
    mockListChannelThreadFollowers.mockResolvedValue([]);

    await triggerMentionedAgentResponses({ ...baseParams, parentId: 'root-1' });

    const insertInput = mockInsertChannelThreadReply.mock.calls[0][0] as {
      aiMeta: { commandExecution?: unknown };
    };
    expect(insertInput.aiMeta.commandExecution).toEqual([
      {
        label: 'release-checklist',
        status: 'skipped',
        reason: 'disabled',
      },
    ]);
  });

  it('omits commandExecution entirely when there is no command', async () => {
    mockPlanCommandExecutions.mockResolvedValue([]);
    await triggerMentionedAgentResponses(baseParams);

    const sendOptions = mockSendChannelExecute.mock.calls[0][1] as {
      experimental_context: Record<string, unknown>;
    };
    expect('commandExecution' in sendOptions.experimental_context).toBe(false);
  });

  it('threads feedback for EVERY resolved command, in order, including a skip followed by an inject', async () => {
    // Regression case flagged in review: with only the first plan surfaced,
    // a skip-then-inject ordering would render a misleading pill (showing
    // "Skipped /gone" while the reply was actually informed by the second,
    // successfully-injected command). All resolved commands must be present.
    const otherInjectPlan: CommandExecutionPlan = {
      kind: 'inject',
      injection: {
        commandId: 'other1234567890123456',
        trigger: 'help',
        label: 'help',
        scope: 'builtin',
        description: 'Show available commands.',
        entryPage: null,
        children: [],
      },
    };
    mockPlanCommandExecutions.mockResolvedValue([skipPlan, otherInjectPlan]);
    await triggerMentionedAgentResponses(baseParams);

    const sendOptions = mockSendChannelExecute.mock.calls[0][1] as {
      experimental_context: { commandExecution?: unknown };
    };
    expect(sendOptions.experimental_context.commandExecution).toEqual([
      { label: 'release-checklist', status: 'skipped', reason: 'disabled' },
      { label: 'help', status: 'used' },
    ]);
  });
});
