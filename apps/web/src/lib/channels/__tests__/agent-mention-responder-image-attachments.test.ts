import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
      channelMessages: { findMany: vi.fn() },
      files: { findMany: vi.fn() },
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
vi.mock('@pagespace/db/schema/storage', () => ({
  files: { id: 'id' },
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
  toContentHash: (storagePath: string) => {
    const m = storagePath.match(/^files\/([a-f0-9]{64})\/original$/i);
    return m ? m[1].toLowerCase() : storagePath;
  },
}));

import { db } from '@pagespace/db/db';
import { triggerMentionedAgentResponses, type TriggerMentionedAgentResponsesParams } from '../agent-mention-responder';

const mockPagesFindMany = db.query.pages.findMany as unknown as Mock;
const mockChannelMessagesFindMany = db.query.channelMessages.findMany as unknown as Mock;
const mockFilesFindMany = db.query.files.findMany as unknown as Mock;

const STORED_CONTENT_HASH = 'a'.repeat(64);

const fileRow = {
  id: 'file-1',
  driveId: 'file-drive-1',
  sizeBytes: 2048,
  mimeType: 'image/png',
  storagePath: `files/${STORED_CONTENT_HASH}/original`,
};

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
  // Client-supplied at message-POST time. contentHash/mimeType/size here are
  // deliberately WRONG relative to the files row — the resolver must never
  // trust them for signing (only originalName, as a display label).
  attachmentMeta: {
    originalName: 'screenshot.png',
    size: 999999999,
    mimeType: 'image/png',
    contentHash: 'forged-hash',
  },
};

describe('triggerMentionedAgentResponses — image attachment plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelMessagesFindMany.mockResolvedValue([imageMessage]);
    mockFilesFindMany.mockResolvedValue([fileRow]);
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

    // Access-checked against the file row's own drive, not the channel's.
    expect(mockCanUserAccessFile).toHaveBeenCalledWith('user-1', 'file-1', 'file-drive-1');
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toEqual([
      { type: 'file', url: 'https://example.com/signed/screenshot.png', mediaType: 'image/png', filename: 'screenshot.png' },
    ]);
  });

  it('signs the stored files row, never the client-supplied attachmentMeta contentHash', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    expect(mockGeneratePresignedUrl).toHaveBeenCalledTimes(1);
    expect(mockGeneratePresignedUrl).toHaveBeenCalledWith(
      STORED_CONTENT_HASH,
      'original',
      3600,
      undefined,
      'image/png'
    );
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalledWith(
      'forged-hash',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('given a fileId with no matching files row, skips it without access checks or signing', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);
    mockFilesFindMany.mockResolvedValue([]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    expect(mockCanUserAccessFile).not.toHaveBeenCalled();
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toBeUndefined();
  });

  it('given a stored file whose real mime type is not an image, skips it even if attachmentMeta claims image/png', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);
    mockFilesFindMany.mockResolvedValue([{ ...fileRow, mimeType: 'application/pdf' }]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    expect(mockCanUserAccessFile).not.toHaveBeenCalled();
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toBeUndefined();
  });

  it('given a stored file over the size cap, resolves but filters it out', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);
    mockFilesFindMany.mockResolvedValue([{ ...fileRow, sizeBytes: 5 * 1024 * 1024 }]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toBeUndefined();
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

  it('given the same fileId attached to multiple recent messages, access-checks and signs it only once', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);
    // Same fileId re-shared across three of the recent messages, plus one distinct image.
    mockChannelMessagesFindMany.mockResolvedValue([
      { ...imageMessage, createdAt: new Date('2026-07-01T00:00:00.000Z') },
      { ...imageMessage, createdAt: new Date('2026-07-01T00:01:00.000Z') },
      {
        ...imageMessage,
        fileId: 'file-2',
        createdAt: new Date('2026-07-01T00:02:00.000Z'),
        attachmentMeta: { ...imageMessage.attachmentMeta, originalName: 'other.png' },
      },
      { ...imageMessage, createdAt: new Date('2026-07-01T00:03:00.000Z') },
    ]);
    mockFilesFindMany.mockResolvedValue([
      fileRow,
      { ...fileRow, id: 'file-2', storagePath: `files/${'b'.repeat(64)}/original` },
    ]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    // Two distinct files, not four — the repeated fileId is deduped before
    // any access-check or presign work, and doesn't crowd out the distinct one.
    expect(mockCanUserAccessFile).toHaveBeenCalledTimes(2);
    expect(mockGeneratePresignedUrl).toHaveBeenCalledTimes(2);
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toHaveLength(2);
  });

  it('given a files row with no storagePath (reaped/stub blob), skips it rather than signing a dead key', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);
    mockFilesFindMany.mockResolvedValue([{ ...fileRow, storagePath: null }]);

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    expect(mockCanUserAccessFile).not.toHaveBeenCalled();
    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toBeUndefined();
  });

  it('given attachment resolution throws (e.g. S3 signing failure), still sends a text-only reply instead of dropping the mention entirely', async () => {
    mockPagesFindMany.mockResolvedValue([
      { id: 'agent-1', title: 'Vision Agent', enabledTools: ['send_channel_message'], aiProvider: 'anthropic', aiModel: 'claude-sonnet-4.5' },
    ]);
    mockGeneratePresignedUrl.mockRejectedValue(new Error('S3 signer unavailable'));

    await triggerMentionedAgentResponses({
      ...baseParams,
      content: '@[Vision Agent](agent-1:page) look at this',
    });

    // The mention still gets a reply — image resolution degrades to
    // text-only rather than aborting triggerMentionedAgentResponses entirely.
    expect(mockAskAgentExecute).toHaveBeenCalledTimes(1);
    const askArgs = mockAskAgentExecute.mock.calls[0][0];
    expect(askArgs.imageAttachments).toBeUndefined();
    expect(mockSendChannelExecute).toHaveBeenCalledTimes(1);
  });
});
