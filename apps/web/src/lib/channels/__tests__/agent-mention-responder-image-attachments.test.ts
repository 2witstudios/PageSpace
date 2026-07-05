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
  canUserViewPage: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      debug: vi.fn(),
      child: vi.fn(() => ({ warn: vi.fn(), error: vi.fn() })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

const mockAskAgentExecute = vi.fn();
vi.mock('@/lib/ai/tools/agent-communication-tools', () => ({
  agentCommunicationTools: { ask_agent: { execute: (...args: unknown[]) => mockAskAgentExecute(...args) } },
}));
const mockSendChannelExecute = vi.fn();
vi.mock('@/lib/ai/tools/channel-tools', () => ({
  channelTools: { send_channel_message: { execute: (...args: unknown[]) => mockSendChannelExecute(...args) } },
}));
vi.mock('@pagespace/lib/services/channel-message-repository', () => ({
  channelMessageRepository: {
    insertChannelThreadReply: vi.fn(),
    loadChannelMessageWithRelations: vi.fn(),
    listChannelThreadFollowers: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ 'x-signed': 'yes' })),
}));
vi.mock('@/lib/channels/notify-mentioned-users', () => ({
  notifyMentionedUsers: vi.fn(),
}));
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: vi.fn(),
  broadcastThreadReplyCountUpdated: vi.fn(),
}));

const mockCanUserAccessFile = vi.fn();
vi.mock('@pagespace/lib/permissions/file-access', () => ({
  canUserAccessFile: (...args: unknown[]) => mockCanUserAccessFile(...args),
}));

const mockGeneratePresignedUrl = vi.fn();
vi.mock('@/lib/presigned-url', () => ({
  generatePresignedUrl: (...args: unknown[]) => mockGeneratePresignedUrl(...args),
  getPresignedUrlTtl: () => 3600,
}));

import { db } from '@pagespace/db/db';
import { triggerMentionedAgentResponses, type TriggerMentionedAgentResponsesParams } from '../agent-mention-responder';

const mockPagesFindMany = db.query.pages.findMany as unknown as Mock;
const mockChannelMessagesFindMany = db.query.channelMessages.findMany as unknown as Mock;

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

const imageMessage = {
  content: 'Check this out',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  aiMeta: null,
  user: { name: 'Alice' },
  fileId: 'file-1',
  attachmentMeta: {
    originalName: 'screenshot.png',
    size: 2048,
    mimeType: 'image/png',
    contentHash: 'hash-abc',
  },
};

describe('triggerMentionedAgentResponses — image attachment plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelMessagesFindMany.mockResolvedValue([imageMessage]);
    mockAskAgentExecute.mockResolvedValue({ success: true, response: 'Reply' });
    mockSendChannelExecute.mockResolvedValue({ success: true });
    mockCanUserAccessFile.mockResolvedValue(true);
    mockGeneratePresignedUrl.mockResolvedValue('https://example.com/signed/screenshot.png');
  });

  it('given an eligible agent with vision and a recent image attachment, passes resolved imageAttachments to ask_agent', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    expect(mockCanUserAccessFile).toHaveBeenCalledWith('user-1', 'file-1', 'drive-1');
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toEqual([
      { type: 'file', url: 'https://example.com/signed/screenshot.png', mediaType: 'image/png', filename: 'screenshot.png' },
    ]);
  });

  it('given only non-vision eligible agents, skips resolving image attachments entirely', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-2', title: 'Text Agent', enabledTools: ['send_channel_message'], aiProvider: 'openai', aiModel: 'o1-mini' },
    ]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Text Agent](agent-2:page) look at this',
    });

    expect(mockCanUserAccessFile).not.toHaveBeenCalled();
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toBeUndefined();
  });

  it('given a vision-capable agent but no accessible recent attachments, passes no imageAttachments', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);
    mockCanUserAccessFile.mockResolvedValue(false);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toBeUndefined();
  });
});
