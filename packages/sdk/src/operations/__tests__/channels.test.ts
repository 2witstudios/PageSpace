import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { deleteChannelMessage, sendChannelMessage } from '../channels.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** `loadChannelMessageWithRelations` row shape (`channel-message-repository.ts`), route-serialized. */
const channelMessageFixture = {
  id: 'm1abc',
  content: 'hello channel',
  createdAt: '2026-07-03T12:00:00.000Z',
  pageId: 'p1abc',
  userId: 'u1abc',
  fileId: null,
  attachmentMeta: null,
  isActive: true,
  editedAt: null,
  aiMeta: null,
  parentId: null,
  replyCount: 0,
  lastReplyAt: null,
  mirroredFromId: null,
  quotedMessageId: null,
  user: { id: 'u1abc', name: 'Ada Lovelace', image: null },
  file: null,
  reactions: [],
  mirroredFrom: null,
  quotedMessage: null,
};

describe('channels.sendMessage — request shape', () => {
  it('builds a POST to /api/channels/:pageId/messages with content in the body', () => {
    const request = buildRequest(sendChannelMessage, { pageId: 'p1abc', content: 'hello channel' }, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/channels/p1abc/messages');
    expect(JSON.parse(request.body ?? '{}')).toEqual({ content: 'hello channel' });
  });

  it('sends fileId/attachmentMeta/parentId/alsoSendToParent/quotedMessageId when present', () => {
    const request = buildRequest(
      sendChannelMessage,
      {
        pageId: 'p1abc',
        content: 'reply',
        parentId: 'root1',
        alsoSendToParent: true,
      },
      config,
    );
    expect(JSON.parse(request.body ?? '{}')).toEqual({
      content: 'reply',
      parentId: 'root1',
      alsoSendToParent: true,
    });
  });

  it('rejects input missing pageId (path param required)', () => {
    const result = sendChannelMessage.inputSchema.safeParse({ content: 'hi' });
    expect(result.success).toBe(false);
  });

  it('rejects input missing content', () => {
    const result = sendChannelMessage.inputSchema.safeParse({ pageId: 'p1abc' });
    expect(result.success).toBe(false);
  });

  it('accepts an empty content string (route: attachment-only messages are valid, no min-length guard)', () => {
    const result = sendChannelMessage.inputSchema.safeParse({ pageId: 'p1abc', content: '', fileId: 'f1abc' });
    expect(result.success).toBe(true);
  });
});

describe('channels.sendMessage — response contract', () => {
  it('parses a 201 top-level message with quotedMessage: null', () => {
    const result = parseResponse(sendChannelMessage, 201, new Headers(), JSON.stringify(channelMessageFixture));
    expect(result).toEqual(channelMessageFixture);
  });

  it('parses a 201 top-level message with a quotedMessage snapshot', () => {
    const withQuote = {
      ...channelMessageFixture,
      quotedMessageId: 'q1abc',
      quotedMessage: {
        id: 'q1abc',
        authorId: 'u2abc',
        authorName: 'Grace Hopper',
        authorImage: null,
        contentSnippet: 'original message',
        createdAt: '2026-07-03T11:00:00.000Z',
        isActive: true,
      },
    };
    const result = parseResponse(sendChannelMessage, 201, new Headers(), JSON.stringify(withQuote));
    expect(result).toEqual(withQuote);
  });

  it('parses a thread-reply response that omits the quotedMessage key entirely (route: thread branch never calls attachQuotedMessages)', () => {
    const threadReply: Record<string, unknown> = { ...channelMessageFixture, parentId: 'root1' };
    delete threadReply.quotedMessage;
    const result = parseResponse(sendChannelMessage, 201, new Headers(), JSON.stringify(threadReply));
    expect(result).toEqual(threadReply);
  });

  it('parses a message carrying a file attachment and reactions', () => {
    const withFileAndReaction = {
      ...channelMessageFixture,
      fileId: 'f1abc',
      attachmentMeta: { originalName: 'report.pdf', size: 1024, mimeType: 'application/pdf', contentHash: 'abc123' },
      file: { id: 'f1abc', mimeType: 'application/pdf', sizeBytes: 1024 },
      reactions: [
        { id: 'r1abc', messageId: 'm1abc', userId: 'u2abc', emoji: '👍', createdAt: '2026-07-03T12:01:00.000Z', user: { id: 'u2abc', name: 'Grace Hopper' } },
      ],
    };
    const result = parseResponse(sendChannelMessage, 201, new Headers(), JSON.stringify(withFileAndReaction));
    expect(result).toEqual(withFileAndReaction);
  });

  it('parses an AI-authored message (aiMeta set)', () => {
    const aiMessage = {
      ...channelMessageFixture,
      userId: 'agent1',
      user: { id: 'agent1', name: 'Support Agent', image: null },
      aiMeta: { senderType: 'agent', senderName: 'Support Agent', agentPageId: 'ag1abc' },
    };
    const result = parseResponse(sendChannelMessage, 201, new Headers(), JSON.stringify(aiMessage));
    expect(result).toEqual(aiMessage);
  });

  it('parses an AI-authored message with the current array-shaped commandExecution (one entry per resolved command, Universal Commands multi-command support)', () => {
    const aiMessage = {
      ...channelMessageFixture,
      userId: 'agent1',
      user: { id: 'agent1', name: 'Support Agent', image: null },
      aiMeta: {
        senderType: 'agent',
        senderName: 'Support Agent',
        agentPageId: 'ag1abc',
        commandExecution: [
          { label: 'release-checklist', status: 'used', entryPageTitle: 'Release Checklist' },
          { label: 'standup', status: 'skipped', reason: 'disabled' },
        ],
      },
    };
    const result = parseResponse(sendChannelMessage, 201, new Headers(), JSON.stringify(aiMessage));
    expect(result).toEqual(aiMessage);
  });

  it('normalizes a LEGACY single-object commandExecution (persisted before multi-command support shipped, no data migration) into a one-element array', () => {
    const legacyAiMessage = {
      ...channelMessageFixture,
      userId: 'agent1',
      user: { id: 'agent1', name: 'Support Agent', image: null },
      aiMeta: {
        senderType: 'agent',
        senderName: 'Support Agent',
        agentPageId: 'ag1abc',
        commandExecution: { label: 'release-checklist', status: 'used', entryPageTitle: 'Release Checklist' },
      },
    };
    const result = parseResponse(sendChannelMessage, 201, new Headers(), JSON.stringify(legacyAiMessage));
    expect(result).toEqual({
      ...legacyAiMessage,
      aiMeta: {
        ...legacyAiMessage.aiMeta,
        commandExecution: [{ label: 'release-checklist', status: 'used', entryPageTitle: 'Release Checklist' }],
      },
    });
  });

  it('rejects a response that drifts from the message row contract', () => {
    const malformed = { ...channelMessageFixture, replyCount: 'not-a-number' };
    const result = parseResponse(sendChannelMessage, 201, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 403 (no edit permission) as PermissionDeniedError', () => {
    const result = parseResponse(
      sendChannelMessage,
      403,
      new Headers(),
      JSON.stringify({ error: 'You need edit permission to send messages in this channel' }),
    );
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('channels.sendMessage — metadata (non-idempotent)', () => {
  it('requires drive scope', () => {
    expect(sendChannelMessage.requiredScope).toBe('drive');
  });

  it('uses POST, which isIdempotentMethod classifies as non-idempotent (no auto-retry — a retried send double-posts)', () => {
    expect(sendChannelMessage.method).toBe('POST');
  });

  it('is not flagged destructive (sending a message is additive, not irreversible data loss)', () => {
    expect(sendChannelMessage.destructive).toBeUndefined();
  });
});

describe('channels.deleteMessage — request shape', () => {
  it('builds a DELETE to /api/channels/:pageId/messages/:messageId with no body', () => {
    const request = buildRequest(deleteChannelMessage, { pageId: 'p1abc', messageId: 'm1abc' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/channels/p1abc/messages/m1abc');
    expect(request.body).toBeUndefined();
  });

  it('rejects input missing messageId', () => {
    const result = deleteChannelMessage.inputSchema.safeParse({ pageId: 'p1abc' });
    expect(result.success).toBe(false);
  });
});

describe('channels.deleteMessage — response contract', () => {
  it('parses { success: true }', () => {
    const result = parseResponse(deleteChannelMessage, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });

  it('classifies a 404 (message not found, or already deleted) as NotFoundError — a concurrent delete is not re-broadcast', () => {
    const result = parseResponse(deleteChannelMessage, 404, new Headers(), JSON.stringify({ error: 'Message not found' }));
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });

  it('classifies a 403 (not the message author) as PermissionDeniedError', () => {
    const result = parseResponse(
      deleteChannelMessage,
      403,
      new Headers(),
      JSON.stringify({ error: 'You can only delete your own messages' }),
    );
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('channels.deleteMessage — metadata (destructive, non-idempotent)', () => {
  it('requires drive scope', () => {
    expect(deleteChannelMessage.requiredScope).toBe('drive');
  });

  it('is flagged destructive so the CLI requires --yes', () => {
    expect(deleteChannelMessage.destructive).toBe(true);
  });

  it('uses DELETE, which isIdempotentMethod classifies as non-idempotent (no auto-retry)', () => {
    expect(deleteChannelMessage.method).toBe('DELETE');
  });
});
