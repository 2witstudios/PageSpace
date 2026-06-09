import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSet = vi.hoisted(() => vi.fn().mockReturnValue({ where: mockWhere }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    update: vi.fn().mockReturnValue({ set: mockSet }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
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
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', name: 'name', image: 'image' } }));

import { chatMessageRepository, type ToolResult } from '../chat-message-repository';
import { db } from '@pagespace/db/db';
import { chatMessages } from '@pagespace/db/schema/core';

describe('chatMessageRepository.updateMessageToolResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockReturnValue({ where: mockWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);
  });

  it('should UPDATE chatMessages table scoped to the given message and conversation IDs', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'file contents', state: 'output-available' },
    ];
    await chatMessageRepository.updateMessageToolResults('msg-abc', 'conv-123', results);

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
    await chatMessageRepository.updateMessageToolResults('msg-abc', 'conv-123', []);

    expect(db.update).not.toHaveBeenCalled();
  });

  it('should handle multiple tool results and scope to the correct conversation', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'contents', state: 'output-available' },
      { toolCallId: 'tc-2', toolName: 'Bash', output: 'exit 0', state: 'output-available' },
    ];
    await chatMessageRepository.updateMessageToolResults('msg-xyz', 'conv-456', results);

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
    await chatMessageRepository.updateMessageToolResults('msg-err', 'conv-789', results);

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
