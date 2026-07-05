import { beforeEach, describe, it, vi, type Mock } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';

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
      child: vi.fn(() => ({ warn: vi.fn(), error: vi.fn() })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@/lib/ai/tools/agent-communication-tools', () => ({
  agentCommunicationTools: { ask_agent: { execute: vi.fn() } },
}));
vi.mock('@/lib/ai/tools/channel-tools', () => ({
  channelTools: { send_channel_message: { execute: vi.fn() } },
}));
vi.mock('@pagespace/lib/services/channel-message-repository', () => ({
  channelMessageRepository: {
    insertChannelThreadReply: vi.fn(),
    loadChannelMessageWithRelations: vi.fn(),
    listChannelThreadFollowers: vi.fn(),
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

import { db } from '@pagespace/db/db';
import { resolveMentionedAgents, fetchRecentChannelMessages } from '../agent-mention-responder';

const mockPagesFindMany = db.query.pages.findMany as unknown as Mock;
const mockChannelMessagesFindMany = db.query.channelMessages.findMany as unknown as Mock;

describe('resolveMentionedAgents — hasVision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a mentioned agent configured with a vision-capable model, should expose hasVision: true', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: [], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);

    const agents = await resolveMentionedAgents('Hey @[Vision Agent](agent-1:page)');

    assert({
      given: 'an agent configured with a vision-capable model',
      should: 'expose hasVision: true on the resolved agent',
      actual: agents.find((a) => a.id === 'agent-1')?.hasVision,
      expected: true,
    });
  });

  it('given a mentioned agent configured with a non-vision model, should expose hasVision: false', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-2', title: 'Text Agent', enabledTools: [], aiProvider: 'openai', aiModel: 'o1-mini' },
    ]);

    const agents = await resolveMentionedAgents('Hey @[Text Agent](agent-2:page)');

    assert({
      given: 'an agent configured with a non-vision model',
      should: 'expose hasVision: false on the resolved agent',
      actual: agents.find((a) => a.id === 'agent-2')?.hasVision,
      expected: false,
    });
  });

  it('given a mentioned agent with no aiModel configured, should fall back to the default model to decide hasVision', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-3', title: 'Default Agent', enabledTools: [], aiProvider: null, aiModel: null },
    ]);

    const agents = await resolveMentionedAgents('Hey @[Default Agent](agent-3:page)');

    assert({
      given: 'an agent with no aiModel configured',
      should: 'still return a boolean hasVision (falling back to the default model)',
      actual: typeof agents.find((a) => a.id === 'agent-3')?.hasVision,
      expected: 'boolean',
    });
  });
});

describe('fetchRecentChannelMessages — attachment data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given recent channel messages with an image attachment, should expose fileId and attachmentMeta', async () => {
    mockChannelMessagesFindMany.mockResolvedValue([
      {
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
      },
    ]);

    const messages = await fetchRecentChannelMessages('channel-1');

    assert({
      given: 'a recent channel message with an image attachment',
      should: 'expose fileId and attachmentMeta on the returned row',
      actual: { fileId: messages[0].fileId, attachmentMeta: messages[0].attachmentMeta },
      expected: {
        fileId: 'file-1',
        attachmentMeta: {
          originalName: 'screenshot.png',
          size: 2048,
          mimeType: 'image/png',
          contentHash: 'hash-abc',
        },
      },
    });
  });

  it('given a recent channel message with no attachment, should expose null fileId and attachmentMeta', async () => {
    mockChannelMessagesFindMany.mockResolvedValue([
      {
        content: 'Just text',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        aiMeta: null,
        user: { name: 'Alice' },
        fileId: null,
        attachmentMeta: null,
      },
    ]);

    const messages = await fetchRecentChannelMessages('channel-1');

    assert({
      given: 'a recent channel message with no attachment',
      should: 'expose null fileId and attachmentMeta',
      actual: { fileId: messages[0].fileId, attachmentMeta: messages[0].attachmentMeta },
      expected: { fileId: null, attachmentMeta: null },
    });
  });
});
