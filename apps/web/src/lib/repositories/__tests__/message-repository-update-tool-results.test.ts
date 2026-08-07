import { describe, it, expect, vi, beforeEach } from 'vitest';

// The v1 completions route's client-tool-result backfill. It was dual-leg and
// transactional through Phase 4 PR 10; PR 14 froze `chat_messages`, so it is
// now ONE statement against the unified `messages` table — a single UPDATE,
// atomic on its own, with no transaction left to wrap. `mockWhere` still has
// to return a `.returning()`, which is how the shared writer reads the
// affected-row count.
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

  it('writes the unified table ONLY — the frozen leg gets no statement', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'file contents', state: 'output-available' },
    ];
    await messageRepository.updateMessageToolResults('msg-abc', 'conv-123', results);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(messages);
    expect(mockUpdate).not.toHaveBeenCalledWith(chatMessages);
    expect(mockSet).toHaveBeenCalledWith({ toolResults: JSON.stringify(results) });
  });

  it('scopes the write by conversationId as well as id — the caller\'s authority boundary', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'contents', state: 'output-available' },
    ];
    await messageRepository.updateMessageToolResults('msg-abc', 'conv-123', results);

    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockWhere.mock.calls[0][0]).toMatchObject({
      type: 'and',
      conditions: expect.arrayContaining([
        { type: 'eq', field: 'id', value: 'msg-abc' },
        { type: 'eq', field: 'conversationId', value: 'conv-123' },
      ]),
    });
  });

  it('should UPDATE the message table scoped to the given message and conversation IDs', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'file contents', state: 'output-available' },
    ];
    await messageRepository.updateMessageToolResults('msg-abc', 'conv-123', results);

    expect(db.update).toHaveBeenCalledWith(messages);
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

    expect(db.update).toHaveBeenCalledWith(messages);
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

    expect(db.update).toHaveBeenCalledWith(messages);
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
