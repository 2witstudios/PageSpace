import { describe, it, expect, vi, beforeEach } from 'vitest';

// The write is now TRANSACTIONAL and DUAL-LEG (Phase 4 PR 10): the same
// statement is issued against `chat_messages` and the unified `messages`
// table, in one transaction, so the v1 completions route's client-tool-result
// backfill cannot land on one leg only. `mockWhere` therefore has to return a
// `.returning()` (the unified leg reads the affected-row count), and `db`
// needs a `transaction`.
const mockReturning = vi.hoisted(() => vi.fn().mockResolvedValue([{ id: 'msg-abc' }]));
const mockWhere = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    returning: mockReturning,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  }),
);
const mockSet = vi.hoisted(() => vi.fn().mockReturnValue({ where: mockWhere }));
const mockUpdate = vi.hoisted(() => vi.fn().mockReturnValue({ set: mockSet }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    update: mockUpdate,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ update: mockUpdate })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  or: vi.fn((...conditions) => ({ type: 'or', conditions })),
  ne: vi.fn((field, value) => ({ type: 'ne', field, value })),
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
  desc: vi.fn((field) => ({ type: 'desc', field })),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: {
    id: 'id',
    pageId: 'pageId',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
    content: 'content',
    editedAt: 'editedAt',
    toolResults: 'toolResults',
  },
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    isActive: 'isActive',
    toolResults: 'toolResults',
    pageId: 'pageId',
  },
  conversations: { id: 'id', isActive: 'isActive', type: 'type', contextId: 'contextId' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', name: 'name', image: 'image' } }));
vi.mock('@pagespace/lib/encryption/field-crypto', () => ({ decryptField: vi.fn(async (v) => v) }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/ai/global-channel-id', () => ({ globalChannelId: (id: string) => `user:${id}:global` }));
vi.mock('@/lib/channels/notify-mentioned-users', () => ({ notifyMentionedUsers: vi.fn() }));
vi.mock('@/lib/ai/core/message-utils', () => ({
  extractStructuredContentFromParts: vi.fn(async (_p: unknown, c: string) => c),
  convertDbMessageToUIMessage: vi.fn(async () => ({ id: 'm', role: 'assistant', parts: [] })),
  MessageConversationConflictError: class extends Error {},
}));
vi.mock('@/lib/websocket/conversation-events', () => ({
  SERVER_TRIGGERED_BROWSER_SESSION: 'server',
  conversationEvents: {
    messageCreated: vi.fn(), messageUpdated: vi.fn(), messageDeleted: vi.fn(),
    undoApplied: vi.fn(), created: vi.fn(),
  },
}));
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastAiMessageEdited: vi.fn(), broadcastAiMessageDeleted: vi.fn(), broadcastAiUndoApplied: vi.fn(),
}));
vi.mock('@/lib/repositories/conversation-rev', () => ({
  bumpConversationRev: vi.fn().mockResolvedValue(null), emitContextFromRow: vi.fn(),
}));

import { messageRepository } from '../message-repository';
import type { ToolResult } from '@/lib/ai/core/message-utils';
import { db } from '@pagespace/db/db';
import { chatMessages } from '@pagespace/db/schema/core';
import { messages } from '@pagespace/db/schema/conversations';

describe('messageRepository.updateMessageToolResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([{ id: 'msg-abc' }]);
    mockWhere.mockReturnValue({
      returning: mockReturning,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    });
    mockSet.mockReturnValue({ where: mockWhere });
    mockUpdate.mockReturnValue({ set: mockSet });
  });

  it('writes BOTH legs, in one transaction, with the identical serialization', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'file contents', state: 'output-available' },
    ];
    await messageRepository.updateMessageToolResults('msg-abc', 'conv-123', results);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(chatMessages);
    expect(mockUpdate).toHaveBeenCalledWith(messages);
    // One `JSON.stringify`, handed to both legs — the columns must be
    // byte-identical, not merely equivalent.
    for (const call of mockSet.mock.calls) {
      expect(call[0]).toEqual({ toolResults: JSON.stringify(results) });
    }
  });

  it('scopes the unified leg by conversationId too, exactly like the legacy leg', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'contents', state: 'output-available' },
    ];
    await messageRepository.updateMessageToolResults('msg-abc', 'conv-123', results);

    // Two WHEREs, one per leg, both carrying the id AND the conversation.
    expect(mockWhere).toHaveBeenCalledTimes(2);
    for (const call of mockWhere.mock.calls) {
      expect(call[0]).toMatchObject({
        type: 'and',
        conditions: expect.arrayContaining([
          { type: 'eq', field: 'id', value: 'msg-abc' },
          { type: 'eq', field: 'conversationId', value: 'conv-123' },
        ]),
      });
    }
  });

  it('given the kill switch off, writes the legacy leg only', async () => {
    vi.stubEnv('UNIFIED_MESSAGES_DUAL_WRITE', 'off');
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'contents', state: 'output-available' },
    ];

    await messageRepository.updateMessageToolResults('msg-abc', 'conv-123', results);

    expect(mockUpdate).toHaveBeenCalledWith(chatMessages);
    expect(mockUpdate).not.toHaveBeenCalledWith(messages);
    vi.unstubAllEnvs();
  });

  it('should UPDATE chatMessages table scoped to the given message and conversation IDs', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'file contents', state: 'output-available' },
    ];
    await messageRepository.updateMessageToolResults('msg-abc', 'conv-123', results);

    expect(db.update).toHaveBeenCalledWith(chatMessages);
    expect(mockSet).toHaveBeenCalledWith({ toolResults: JSON.stringify(results) });
    // WHERE must be an AND combining both id and conversationId conditions
    const whereArg = mockWhere.mock.calls[0][0];
    expect(whereArg).toMatchObject({
      type: 'and',
      conditions: expect.arrayContaining([
        { type: 'eq', field: 'id', value: 'msg-abc' },
        { type: 'eq', field: 'conversationId', value: 'conv-123' },
      ]),
    });
  });

  it('should no-op when toolResults array is empty', async () => {
    await messageRepository.updateMessageToolResults('msg-abc', 'conv-123', []);

    expect(db.update).not.toHaveBeenCalled();
  });

  it('should handle multiple tool results and scope to the correct conversation', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'contents', state: 'output-available' },
      { toolCallId: 'tc-2', toolName: 'Bash', output: 'exit 0', state: 'output-available' },
    ];
    await messageRepository.updateMessageToolResults('msg-xyz', 'conv-456', results);

    expect(db.update).toHaveBeenCalledWith(chatMessages);
    expect(mockSet).toHaveBeenCalledWith({ toolResults: JSON.stringify(results) });
    const whereArg = mockWhere.mock.calls[0][0];
    expect(whereArg).toMatchObject({
      type: 'and',
      conditions: expect.arrayContaining([
        { type: 'eq', field: 'id', value: 'msg-xyz' },
        { type: 'eq', field: 'conversationId', value: 'conv-456' },
      ]),
    });
  });

  it('should handle error-state tool results and scope to the correct conversation', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Bash', output: null, state: 'output-error', errorText: 'command not found' },
    ];
    await messageRepository.updateMessageToolResults('msg-err', 'conv-789', results);

    expect(db.update).toHaveBeenCalledWith(chatMessages);
    expect(mockSet).toHaveBeenCalledWith({ toolResults: JSON.stringify(results) });
    const whereArg = mockWhere.mock.calls[0][0];
    expect(whereArg).toMatchObject({
      type: 'and',
      conditions: expect.arrayContaining([
        { type: 'eq', field: 'id', value: 'msg-err' },
        { type: 'eq', field: 'conversationId', value: 'conv-789' },
      ]),
    });
  });
});
