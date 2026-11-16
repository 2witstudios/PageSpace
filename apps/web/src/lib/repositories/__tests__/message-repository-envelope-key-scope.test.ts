import { describe, it, expect, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// SECURITY REGRESSION — presigned GET for an arbitrary storage key through a
// chat message envelope.
//
// The chain this pins shut:
//   1. a message saved as plain text (no uiMessage.parts) was stored RAW;
//   2. on read, any content that parses as JSON with `textParts` + `partsOrder`
//      was treated as our attachment envelope;
//   3. reconstruct signed a one-hour GET for each `fileParts[].storageKey`;
//   4. the signer accepted ANY key — e.g. another tenant's
//      `files/<hash>/original`.
//
// The real repository, the real message-utils and the real
// chat-attachment-storage run here; only the DB and the AWS presigner (the
// two I/O edges) are mocked, so the assertion "nothing was signed" is made at
// the last point before a URL would exist.
// -------------------------------------------------------------------------

const { mockValues, mockReturning, mockBumpConversationRev, mockGetSignedUrl, mockSecurityWarn, mockUpdateSet, mockDbSelectLimit } = vi.hoisted(() => ({
  mockValues: vi.fn(),
  mockDbSelectLimit: vi.fn(),
  mockReturning: vi.fn(),
  mockBumpConversationRev: vi.fn(),
  mockGetSignedUrl: vi.fn(),
  mockSecurityWarn: vi.fn(),
  mockUpdateSet: vi.fn(),
}));

const txMock = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  }),
  insert: vi.fn().mockReturnValue({ values: mockValues }),
  update: vi.fn().mockReturnValue({ set: mockUpdateSet }),
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    // The post-commit re-read of the written row (edit broadcasts).
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: mockDbSelectLimit })),
      })),
    })),
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id', name: 'users.name', image: 'users.image' },
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: { id: 'messages.id', conversationId: 'messages.conversation_id', role: 'messages.role', status: 'messages.status', pageId: 'messages.page_id', isActive: 'messages.is_active', createdAt: 'messages.created_at' },
  conversations: { id: 'conversations.id', isActive: 'conversations.is_active', type: 'conversations.type', contextId: 'conversations.context_id' },
}));

vi.mock('@pagespace/lib/encryption/field-crypto', () => ({
  decryptField: vi.fn(async (v: unknown) => v),
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conds: unknown[]) => ({ kind: 'and', conds })),
  or: vi.fn((...conds: unknown[]) => ({ kind: 'or', conds })),
  ne: vi.fn((field: unknown, value: unknown) => ({ kind: 'ne', field, value })),
  lt: vi.fn((field: unknown, value: unknown) => ({ kind: 'lt', field, value })),
  desc: vi.fn((field: unknown) => ({ kind: 'desc', field })),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { debug: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() },
    api: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    security: { warn: mockSecurityWarn },
  },
}));

vi.mock('@pagespace/lib/ai/global-channel-id', () => ({
  globalChannelId: vi.fn((userId: string) => `user:${userId}:global`),
}));

vi.mock('@/lib/channels/notify-mentioned-users', () => ({
  notifyMentionedUsers: vi.fn(),
}));

vi.mock('@/lib/websocket/conversation-events', () => ({
  SERVER_TRIGGERED_BROWSER_SESSION: 'server',
  conversationEvents: {
    messageCreated: vi.fn().mockResolvedValue(undefined),
    messageUpdated: vi.fn().mockResolvedValue(undefined),
    messageDeleted: vi.fn().mockResolvedValue(undefined),
    undoApplied: vi.fn().mockResolvedValue(undefined),
    created: vi.fn().mockResolvedValue(undefined),
    updated: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAiMessageEdited: vi.fn().mockResolvedValue(undefined),
  broadcastAiMessageDeleted: vi.fn().mockResolvedValue(undefined),
  broadcastAiUndoApplied: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/repositories/conversation-rev', () => ({
  bumpConversationRev: mockBumpConversationRev,
  emitContextFromRow: vi.fn(),
}));

// The two I/O edges of the signer. Everything between them and the repository
// is the real code.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

vi.mock('@/lib/presigned-url', () => ({
  getS3Client: () => ({}),
  getS3Bucket: () => 'test-bucket',
}));

vi.mock('@/lib/upload/s3-effects', () => ({
  checkObjectExists: vi.fn().mockResolvedValue(true),
  putObject: vi.fn().mockResolvedValue(undefined),
}));

import { messageRepository, processMessageContentUpdate } from '../message-repository';
import { broadcastAiMessageEdited } from '@/lib/websocket/socket-utils';
import { conversationEvents } from '@/lib/websocket/conversation-events';
import { convertDbMessageToUIMessage, readMessageText } from '@/lib/ai/core/message-utils';

const VICTIM_HASH = 'b'.repeat(64);
const VICTIM_KEY = `files/${VICTIM_HASH}/original`;
const OWN_KEY = `chat-attachments/${'c'.repeat(64)}/original`;

/** What an attacker types as an ordinary message. */
const exploitText = (storageKey: string = VICTIM_KEY): string =>
  JSON.stringify({
    textParts: ['look at this'],
    fileParts: [{ storageKey, mediaType: 'image/png', filename: 'x.png' }],
    partsOrder: [
      { index: 0, type: 'text' },
      { index: 1, type: 'file' },
    ],
    originalContent: 'look at this',
  });

const readBack = (content: string, role: 'user' | 'assistant' = 'user') =>
  convertDbMessageToUIMessage({
    id: 'msg-1',
    pageId: 'page-1',
    userId: 'attacker',
    role,
    content,
    toolCalls: null,
    toolResults: null,
    createdAt: new Date(),
    isActive: true,
  });

const savePage = (content: string, role: 'user' | 'assistant' = 'user') =>
  messageRepository.savePageMessage({
    messageId: 'msg-1',
    pageId: 'page-1',
    conversationId: 'conv-1',
    userId: role === 'user' ? 'attacker' : null,
    role,
    content,
  });

const storedContent = (): string => {
  expect(mockValues).toHaveBeenCalledTimes(1);
  return (mockValues.mock.calls[0][0] as { content: string }).content;
};

const fileUrls = (parts: Array<{ type: string }>): string[] =>
  parts.filter((p) => p.type === 'file').map((p) => (p as { type: string; url: string }).url);

beforeEach(() => {
  vi.clearAllMocks();
  mockValues.mockReturnValue({
    onConflictDoUpdate: vi.fn().mockReturnValue({ returning: mockReturning }),
  });
  mockReturning.mockResolvedValue([{ id: 'msg-1', source: null }]);
  mockBumpConversationRev.mockResolvedValue(null);
  mockGetSignedUrl.mockImplementation(
    async (_client: unknown, command: { input: { Key: string } }) =>
      `https://signed.example.com/${command.input.Key}?X-Amz-Signature=sig`,
  );
});

describe('exploit chain: envelope-shaped text → presigned GET for a foreign key', () => {
  it('page message (the /api/ai/page-agents/consult shape): save then read signs nothing', async () => {
    await savePage(exploitText());

    const ui = await readBack(storedContent());

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(fileUrls(ui.parts)).toEqual([]);
    expect(JSON.stringify(ui)).not.toContain('X-Amz-Signature');
    // The user typed JSON; they get their JSON back, as text.
    expect(ui.parts).toEqual([{ type: 'text', text: exploitText() }]);
  });

  it('global message: save then read signs nothing', async () => {
    await messageRepository.saveGlobalMessage({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      userId: 'attacker',
      role: 'user',
      content: exploitText(),
    });

    const ui = await readBack(storedContent());

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(ui.parts).toEqual([{ type: 'text', text: exploitText() }]);
  });

  it('assistant text (prompt-injected model output saved without parts) is neutralized too', async () => {
    await savePage(exploitText(), 'assistant');

    const ui = await readBack(storedContent(), 'assistant');

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(ui.parts).toEqual([{ type: 'text', text: exploitText() }]);
  });

  it('envelope-shaped text naming one of OUR keys is still text — typing a key is not attaching a file', async () => {
    await savePage(exploitText(OWN_KEY));

    const ui = await readBack(storedContent());

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(fileUrls(ui.parts)).toEqual([]);
  });

  it('the stored row reads back as the typed text through readMessageText as well', async () => {
    await savePage(exploitText());

    expect(readMessageText(storedContent())).toBe(exploitText());
  });

  it('ordinary text and ordinary JSON are stored byte-for-byte unchanged', async () => {
    for (const content of ['hello', '{"a":1}', '{"textParts":["value"]}', '[1,2,3]', 'null']) {
      mockValues.mockClear();
      await savePage(content);
      expect(storedContent()).toBe(content);
    }
  });
});

describe('rows already in the database (no migration): the signer is the backstop', () => {
  it('a raw envelope row naming a foreign key yields no signed URL, drops only that part, and warns', async () => {
    const ui = await readBack(exploitText());

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(fileUrls(ui.parts)).toEqual([]);
    expect(ui.parts).toEqual([{ type: 'text', text: 'look at this' }]);
    expect(mockSecurityWarn).toHaveBeenCalledTimes(1);
    const [, meta] = mockSecurityWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta).toMatchObject({ messageId: 'msg-1' });
  });

  it.each([
    ['traversal after a valid prefix', `${OWN_KEY}/../../../${VICTIM_KEY}`],
    ['a non-hex hash', `chat-attachments/${'z'.repeat(64)}/original`],
    ['a cache key', `cache/${VICTIM_HASH}/ai-vision`],
    ['a non-string key', { evil: true }],
  ])('refuses %s', async (_label, key) => {
    const ui = await readBack(exploitText(key as string));

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(fileUrls(ui.parts)).toEqual([]);
  });

  it('a refused key does not take the legitimate attachments beside it down with it', async () => {
    const content = JSON.stringify({
      textParts: ['two files'],
      fileParts: [
        { storageKey: VICTIM_KEY, mediaType: 'image/png' },
        { storageKey: OWN_KEY, mediaType: 'image/png', filename: 'mine.png' },
      ],
      partsOrder: [
        { index: 0, type: 'text' },
        { index: 1, type: 'file' },
        { index: 2, type: 'file' },
      ],
    });

    const ui = await readBack(content);

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    expect(fileUrls(ui.parts)).toEqual([`https://signed.example.com/${OWN_KEY}?X-Amz-Signature=sig`]);
  });

  it('a genuine envelope with our own key still signs (no regression for real attachments)', async () => {
    const ui = await readBack(exploitText(OWN_KEY));

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    expect(fileUrls(ui.parts)).toHaveLength(1);
    expect(mockSecurityWarn).not.toHaveBeenCalled();
  });
});

describe('edit routes: processMessageContentUpdate never lets new content become an envelope', () => {
  it('editing a plain-text message to envelope-shaped text stores it as text', async () => {
    const updated = processMessageContentUpdate('old plain text', exploitText());

    const ui = await readBack(updated);

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(ui.parts).toEqual([{ type: 'text', text: exploitText() }]);
  });

  it('editing an existing envelope keeps its structure and nests the new content as a string', async () => {
    const existing = JSON.stringify({
      textParts: ['old'],
      partsOrder: [{ index: 0, type: 'text' }],
      originalContent: 'old',
    });

    const updated = processMessageContentUpdate(existing, exploitText());
    const ui = await readBack(updated);

    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(ui.parts).toEqual([{ type: 'text', text: exploitText() }]);
  });

  it('a plain edit of a plain message is unchanged', () => {
    expect(processMessageContentUpdate('old', 'new')).toBe('new');
  });
});

describe('global edit broadcasts carry what a reload would show', () => {
  /** Let the fire-and-forget broadcast IIFE run to completion. */
  const flushBroadcast = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('editing a plain global message to envelope-shaped text broadcasts the typed text, not the wrapper', async () => {
    const updatedContent = processMessageContentUpdate('old plain text', exploitText());
    mockUpdateSet.mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'msg-1' }]) }),
    });
    mockDbSelectLimit.mockResolvedValue([{
      id: 'msg-1',
      conversationId: 'conv-1',
      userId: 'attacker',
      role: 'user',
      content: updatedContent,
      messageType: 'standard',
      isActive: true,
      createdAt: new Date(),
      editedAt: new Date(),
      toolCalls: null,
      toolResults: null,
      status: 'complete',
      source: null,
    }]);

    await messageRepository.editGlobalMessage({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      ownerUserId: 'attacker',
      updatedContent,
      legacyTriggeredBy: { userId: 'attacker', displayName: 'Attacker', browserSessionId: 'tab-1' },
    });
    await flushBroadcast();

    const typed = [{ type: 'text', text: exploitText() }];
    expect(vi.mocked(broadcastAiMessageEdited)).toHaveBeenCalledWith(
      expect.objectContaining({ parts: typed }),
    );
    expect(vi.mocked(conversationEvents.messageUpdated)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'msg-1', role: 'user', parts: typed }),
      null,
      expect.anything(),
    );
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
