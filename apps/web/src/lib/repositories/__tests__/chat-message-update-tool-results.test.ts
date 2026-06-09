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
  lt: vi.fn((field, value) => ({ type: 'lt', field, value })),
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

describe('chatMessageRepository.updateMessageToolResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSet.mockReturnValue({ where: mockWhere });
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);
  });

  it('should UPDATE toolResults for the given message ID', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'file contents', state: 'output-available' },
    ];
    await chatMessageRepository.updateMessageToolResults('msg-abc', results);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ toolResults: JSON.stringify(results) });
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it('should no-op when toolResults array is empty', async () => {
    await chatMessageRepository.updateMessageToolResults('msg-abc', []);

    expect(db.update).not.toHaveBeenCalled();
  });

  it('should handle multiple tool results', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Read', output: 'contents', state: 'output-available' },
      { toolCallId: 'tc-2', toolName: 'Bash', output: 'exit 0', state: 'output-available' },
    ];
    await chatMessageRepository.updateMessageToolResults('msg-xyz', results);

    expect(mockSet).toHaveBeenCalledWith({ toolResults: JSON.stringify(results) });
  });

  it('should handle error-state tool results', async () => {
    const results: ToolResult[] = [
      { toolCallId: 'tc-1', toolName: 'Bash', output: null, state: 'output-error', errorText: 'command not found' },
    ];
    await chatMessageRepository.updateMessageToolResults('msg-err', results);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith({ toolResults: JSON.stringify(results) });
  });
});
