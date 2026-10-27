import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { HttpError, ResponseValidationError } from '../../errors.js';
import { listConversations, readConversation } from '../conversations.js';

const config = { baseUrl: 'https://pagespace.ai' };

describe('conversations.list — request shape', () => {
  it('interpolates :agentId and sends pagination as query params', () => {
    const request = buildRequest(listConversations, { agentId: 'a1', page: 1, pageSize: 25 }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/ai/page-agents/a1/conversations?page=1&pageSize=25');
  });

  it('interpolates :agentId with no pagination params at all', () => {
    const request = buildRequest(listConversations, { agentId: 'a1' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/ai/page-agents/a1/conversations');
  });

  it('rejects a pageSize above the route\'s 200 cap', () => {
    expect(listConversations.inputSchema.safeParse({ agentId: 'a1', pageSize: 201 }).success).toBe(false);
  });

  it('rejects a page above the route\'s 10000 cap', () => {
    expect(listConversations.inputSchema.safeParse({ agentId: 'a1', page: 10001 }).success).toBe(false);
  });
});

describe('conversations.list — response contract (route truth: [agentId]/conversations/route.ts)', () => {
  const fixture = {
    conversations: [
      {
        id: 'conv1',
        title: 'Sprint planning',
        preview: 'What is the plan for this sprint?',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T01:00:00.000Z',
        messageCount: 4,
        isShared: false,
        isOwner: true,
        lastMessage: { role: 'assistant', timestamp: '2026-01-01T01:00:00.000Z' },
      },
    ],
    pagination: { page: 0, pageSize: 50, totalCount: 1, totalPages: 1, hasMore: false },
  };

  it('parses a populated conversation list', () => {
    const result = parseResponse(listConversations, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses an empty conversation list', () => {
    const empty = { conversations: [], pagination: { page: 0, pageSize: 50, totalCount: 0, totalPages: 0, hasMore: false } };
    const result = parseResponse(listConversations, 200, new Headers(), JSON.stringify(empty));
    expect(result).toEqual(empty);
  });

  it('accepts a null lastMessage.role (no messages have a role yet)', () => {
    const withNullRole = { ...fixture, conversations: [{ ...fixture.conversations[0], lastMessage: { role: null, timestamp: '2026-01-01T01:00:00.000Z' } }] };
    const result = parseResponse(listConversations, 200, new Headers(), JSON.stringify(withNullRole));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });

  it('classifies a 404 (agent not found) as an HttpError, never a schema mismatch', () => {
    const result = parseResponse(listConversations, 404, new Headers(), JSON.stringify({ error: 'AI agent not found' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as HttpError).status).toBe(404);
  });
});

describe('conversations.read — request shape', () => {
  it('interpolates :agentId and :conversationId and sends cursor params as query', () => {
    const request = buildRequest(
      readConversation,
      { agentId: 'a1', conversationId: 'conv1', limit: 20, cursor: 'msg5', direction: 'after' },
      config,
    );
    expect(request.method).toBe('GET');
    expect(request.url).toBe(
      'https://pagespace.ai/api/ai/page-agents/a1/conversations/conv1/messages?cursor=msg5&direction=after&limit=20',
    );
  });

  it('rejects a limit above the route\'s 200 cap', () => {
    expect(readConversation.inputSchema.safeParse({ agentId: 'a1', conversationId: 'conv1', limit: 201 }).success).toBe(false);
  });

  it('rejects a direction outside before/after', () => {
    expect(readConversation.inputSchema.safeParse({ agentId: 'a1', conversationId: 'conv1', direction: 'sideways' }).success).toBe(false);
  });
});

describe('conversations.read — response contract + parts fidelity (route truth: messages/route.ts)', () => {
  const baseFixture = {
    conversationId: 'conv1',
    messageCount: 2,
    pagination: { hasMore: false, nextCursor: null, prevCursor: 'm2', limit: 50, direction: 'before' },
  };

  it('parses a plain text message', () => {
    const fixture = {
      ...baseFixture,
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'What is the plan?' }], createdAt: '2026-01-01T00:00:00.000Z', messageType: 'standard' },
      ],
    };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses a message with a tool-call part (input-available, no output yet)', () => {
    const fixture = {
      ...baseFixture,
      messages: [
        {
          id: 'm2',
          role: 'assistant',
          parts: [{ type: 'tool-list_pages', toolCallId: 'call1', toolName: 'list_pages', input: { driveId: 'd1' }, state: 'input-available' }],
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ],
    };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses a message with a completed tool-call part (output-available)', () => {
    const fixture = {
      ...baseFixture,
      messages: [
        {
          id: 'm3',
          role: 'assistant',
          parts: [
            {
              type: 'tool-list_pages',
              toolCallId: 'call1',
              toolName: 'list_pages',
              input: { driveId: 'd1' },
              output: { pages: [] },
              state: 'output-available',
            },
          ],
          createdAt: '2026-01-01T00:00:02.000Z',
        },
      ],
    };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses a message with a failed tool-call part (output-error, errorText present)', () => {
    const fixture = {
      ...baseFixture,
      messages: [
        {
          id: 'm4',
          role: 'assistant',
          parts: [{ type: 'tool-list_pages', toolCallId: 'call1', toolName: 'list_pages', state: 'output-error', errorText: 'Drive not found' }],
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      ],
    };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses a message with a file part', () => {
    const fixture = {
      ...baseFixture,
      messages: [
        { id: 'm5', role: 'user', parts: [{ type: 'file', url: 'https://files.pagespace.ai/f1', mediaType: 'image/png', filename: 'diagram.png' }], createdAt: '2026-01-01T00:00:04.000Z' },
      ],
    };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses a message with a custom data-* part', () => {
    const fixture = {
      ...baseFixture,
      messages: [{ id: 'm6', role: 'assistant', parts: [{ type: 'data-command-result', id: 'd1', data: { exitCode: 0 } }], createdAt: '2026-01-01T00:00:05.000Z' }],
    };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses editedAt and userName when present', () => {
    const fixture = {
      ...baseFixture,
      messages: [
        {
          id: 'm7',
          role: 'user',
          parts: [{ type: 'text', text: 'Edited question' }],
          createdAt: '2026-01-01T00:00:06.000Z',
          editedAt: '2026-01-01T00:05:00.000Z',
          userName: 'Ada',
        },
      ],
    };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('rejects a part with no type (drift from route truth)', () => {
    const malformed = { ...baseFixture, messages: [{ id: 'm1', role: 'user', parts: [{ text: 'no type field' }], createdAt: '2026-01-01T00:00:00.000Z' }] };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('rejects a message missing role (drift from route truth)', () => {
    const malformed = { ...baseFixture, messages: [{ id: 'm1', parts: [{ type: 'text', text: 'hi' }], createdAt: '2026-01-01T00:00:00.000Z' }] };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(malformed));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('parses an empty message list', () => {
    const empty = { conversationId: 'conv1', messageCount: 0, messages: [], pagination: { hasMore: false, nextCursor: null, prevCursor: null, limit: 50, direction: 'before' } };
    const result = parseResponse(readConversation, 200, new Headers(), JSON.stringify(empty));
    expect(result).toEqual(empty);
  });

  it('classifies a 403 (private conversation, not the owner) as an HttpError, never a schema mismatch', () => {
    const result = parseResponse(readConversation, 403, new Headers(), JSON.stringify({ error: 'Insufficient permissions to access this conversation' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as HttpError).status).toBe(403);
  });
});

describe('conversations operations — metadata', () => {
  it('every operation is named, described, and scoped for MCP/CLI derivation', () => {
    const ops = [listConversations, readConversation];
    for (const op of ops) {
      expect(op.name.startsWith('conversations.')).toBe(true);
      expect(op.description.length).toBeGreaterThan(0);
      expect(op.requiredScope).toBe('drive');
    }
  });
});
