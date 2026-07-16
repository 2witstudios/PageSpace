import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/openai-api/__tests__/riteway';

// --- module mocks (hoisted before imports) ---

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
  getAllowedDriveIds: vi.fn(() => []),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_col, val) => ({ __eq: val })),
  and: vi.fn((...args) => ({ __and: args })),
  desc: vi.fn((col) => ({ __desc: col })),
  inArray: vi.fn((_col, vals) => ({ __inArray: vals })),
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'conversations.id',
    userId: 'conversations.userId',
    isActive: 'conversations.isActive',
    contextId: 'conversations.contextId',
    updatedAt: 'conversations.updatedAt',
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: {
    id: 'chatMessages.id',
    conversationId: 'chatMessages.conversationId',
    isActive: 'chatMessages.isActive',
    createdAt: 'chatMessages.createdAt',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('new-cuid-123'),
}));

vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: {
    getConversation: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@/lib/repositories/chat-message-repository', () => ({
  chatMessageRepository: {
    getMessagesByConversationId: vi.fn().mockResolvedValue([]),
  },
}));

// --- imports after mocks ---
import { NextResponse } from 'next/server';
import { POST, GET } from '../route';
import { GET as getById, DELETE } from '../[id]/route';
import { db } from '@pagespace/db/db';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { chatMessageRepository } from '@/lib/repositories/chat-message-repository';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { getAllowedDriveIds } from '@/lib/auth/auth-core';

const mcpAuth = {
  userId: 'user-1',
  tokenType: 'mcp' as const,
  tokenId: 'token-1',
  allowedDriveIds: [],
  role: 'user' as const,
  tokenVersion: 1,
  adminRoleVersion: 0,
};

const makePostRequest = (body: unknown) =>
  new Request('http://localhost/api/v1/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mcp_test123' },
    body: JSON.stringify(body),
  });

const makeGetRequest = (path = 'http://localhost/api/v1/conversations') =>
  new Request(path, {
    method: 'GET',
    headers: { Authorization: 'Bearer mcp_test123' },
  });

const makeDeleteRequest = () =>
  new Request('http://localhost/api/v1/conversations/conv-1', {
    method: 'DELETE',
    headers: { Authorization: 'Bearer mcp_test123' },
  });

const existingConversation = {
  id: 'conv-1',
  userId: 'user-1',
  isActive: true,
  title: 'Test Chat',
  contextId: null,
  type: 'client',
  createdAt: new Date('2024-01-15T10:00:00.000Z'),
  updatedAt: new Date('2024-01-15T10:00:00.000Z'),
  isShared: false,
  lastMessageAt: null,
};

describe('POST /api/v1/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpAuth);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
  });

  test('returns 401 when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const response = await POST(makePostRequest({}));
    assert({
      given: 'a request with no valid MCP token',
      should: 'return 401',
      actual: response.status,
      expected: 401,
    });
  });

  test('returns 400 on invalid JSON', async () => {
    const request = new Request('http://localhost/api/v1/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mcp_test123' },
      body: 'not json{',
    });
    const response = await POST(request);
    assert({
      given: 'a request with malformed JSON body',
      should: 'return 400',
      actual: response.status,
      expected: 400,
    });
  });

  test('returns 403 when drive_id is outside MCP token scope', async () => {
    vi.mocked(getAllowedDriveIds).mockReturnValue(['drive-allowed']);
    const response = await POST(makePostRequest({ drive_id: 'drive-other' }));
    assert({
      given: 'a drive_id not in the MCP token\'s scoped drives',
      should: 'return 403',
      actual: response.status,
      expected: 403,
    });
  });

  test('returns 201 with minimal body (no drive_id, no title)', async () => {
    const response = await POST(makePostRequest({}));
    const body = await response.json() as Record<string, unknown>;
    assert({
      given: 'a valid empty body',
      should: 'return 201 with id and object:conversation',
      actual: { status: response.status, id: body.id, object: body.object },
      expected: { status: 201, id: 'new-cuid-123', object: 'conversation' },
    });
  });

  test('returns 201 with title in the response', async () => {
    const response = await POST(makePostRequest({ title: 'My Conversation' }));
    const body = await response.json() as Record<string, unknown>;
    assert({
      given: 'a body with a title',
      should: 'return 201 with the title in the response',
      actual: { status: response.status, title: body.title },
      expected: { status: 201, title: 'My Conversation' },
    });
  });

  test('returns 201 with drive_id set on unscoped token', async () => {
    const response = await POST(makePostRequest({ drive_id: 'drive-xyz' }));
    const body = await response.json() as Record<string, unknown>;
    assert({
      given: 'a body with drive_id on an unscoped token',
      should: 'return 201 with drive_id in the response',
      actual: { status: response.status, drive_id: body.drive_id },
      expected: { status: 201, drive_id: 'drive-xyz' },
    });
  });

  test('inserts a conversations row', async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as unknown as ReturnType<typeof db.insert>);
    await POST(makePostRequest({}));
    assert({
      given: 'a valid create request',
      should: 'call db.insert once',
      actual: vi.mocked(db.insert).mock.calls.length,
      expected: 1,
    });
  });
});

describe('GET /api/v1/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpAuth);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
  });

  test('returns 401 when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const response = await GET(makeGetRequest());
    assert({
      given: 'no valid MCP token',
      should: 'return 401',
      actual: response.status,
      expected: 401,
    });
  });

  test('returns 400 with invalid limit', async () => {
    const response = await GET(makeGetRequest('http://localhost/api/v1/conversations?limit=999'));
    assert({
      given: 'limit=999 (over the max of 100)',
      should: 'return 400',
      actual: response.status,
      expected: 400,
    });
  });

  test('returns 200 with object:list and data array', async () => {
    const response = await GET(makeGetRequest());
    const body = await response.json() as Record<string, unknown>;
    assert({
      given: 'a valid list request with no results',
      should: 'return 200 with object:list and empty data array',
      actual: { status: response.status, object: body.object, isArray: Array.isArray(body.data) },
      expected: { status: 200, object: 'list', isArray: true },
    });
  });

  test('returns conversations with correct shape', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([existingConversation]),
            }),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
    const response = await GET(makeGetRequest());
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    const first = body.data[0];
    assert({
      given: 'a list response with one conversation',
      should: 'serialize the conversation to the OpenAI-shaped format',
      actual: { id: first?.id, object: first?.object, userId: first?.user_id },
      expected: { id: 'conv-1', object: 'conversation', userId: 'user-1' },
    });
  });

  test('returns 403 when scoped token requests a drive outside its allowed drives', async () => {
    vi.mocked(getAllowedDriveIds).mockReturnValue(['drive-allowed']);
    const response = await GET(makeGetRequest('http://localhost/api/v1/conversations?drive_id=drive-other'));
    assert({
      given: 'a scoped MCP token with drive_id outside its allowed drives',
      should: 'return 403',
      actual: response.status,
      expected: 403,
    });
  });
});

describe('GET /api/v1/conversations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpAuth);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
    vi.mocked(conversationRepository.getConversation).mockResolvedValue(null);
    vi.mocked(chatMessageRepository.getMessagesByConversationId).mockResolvedValue([]);
  });

  test('returns 401 when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const response = await getById(makeGetRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    assert({
      given: 'no valid MCP token',
      should: 'return 401',
      actual: response.status,
      expected: 401,
    });
  });

  test('returns 404 when conversation does not exist', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValue(null);
    const response = await getById(makeGetRequest(), { params: Promise.resolve({ id: 'no-such-conv' }) });
    assert({
      given: 'an id that has no matching conversation row',
      should: 'return 404',
      actual: response.status,
      expected: 404,
    });
  });

  test('returns 403 when conversation belongs to a different user', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValue({
      ...existingConversation,
      userId: 'other-user',
    });
    const response = await getById(makeGetRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    assert({
      given: 'a conversation owned by a different user',
      should: 'return 403',
      actual: response.status,
      expected: 403,
    });
  });

  test('returns 200 with conversation and messages array', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValue(existingConversation);
    vi.mocked(chatMessageRepository.getMessagesByConversationId).mockResolvedValue([
      {
        id: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        role: 'user',
        content: 'Hello',
        messageType: 'standard' as const,
        isActive: true,
        createdAt: new Date('2024-01-15T10:00:00.000Z'),
        editedAt: null,
        toolCalls: null,
        toolResults: null,
        status: 'complete' as const,
      },
    ]);
    const response = await getById(makeGetRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    const body = await response.json() as Record<string, unknown>;
    assert({
      given: 'an owned conversation with one message',
      should: 'return 200 with the conversation and its messages',
      actual: {
        status: response.status,
        id: body.id,
        hasMessages: Array.isArray(body.messages) && (body.messages as unknown[]).length === 1,
      },
      expected: { status: 200, id: 'conv-1', hasMessages: true },
    });
  });

  test('returns 200 with empty messages array when no messages exist', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValue(existingConversation);
    vi.mocked(chatMessageRepository.getMessagesByConversationId).mockResolvedValue([]);
    const response = await getById(makeGetRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    const body = await response.json() as Record<string, unknown>;
    assert({
      given: 'an owned conversation with no messages',
      should: 'return 200 with an empty messages array',
      actual: { status: response.status, messages: body.messages },
      expected: { status: 200, messages: [] },
    });
  });

  test('returns 403 when scoped token accesses conversation outside its allowed drives', async () => {
    vi.mocked(getAllowedDriveIds).mockReturnValue(['drive-allowed']);
    vi.mocked(conversationRepository.getConversation).mockResolvedValue({
      ...existingConversation,
      contextId: 'drive-other',
    });
    const response = await getById(makeGetRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    assert({
      given: 'a scoped MCP token reading a conversation tied to a different drive',
      should: 'return 403',
      actual: response.status,
      expected: 403,
    });
  });
});

describe('DELETE /api/v1/conversations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpAuth);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
    vi.mocked(conversationRepository.getConversation).mockResolvedValue(null);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as ReturnType<typeof db.update>);
  });

  test('returns 401 when auth fails', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const response = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    assert({
      given: 'no valid MCP token',
      should: 'return 401',
      actual: response.status,
      expected: 401,
    });
  });

  test('returns 404 when conversation does not exist', async () => {
    const response = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: 'no-conv' }) });
    assert({
      given: 'a delete for a non-existent conversation',
      should: 'return 404',
      actual: response.status,
      expected: 404,
    });
  });

  test('returns 403 when conversation belongs to a different user', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValue({
      ...existingConversation,
      userId: 'other-user',
    });
    const response = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    assert({
      given: 'a delete attempt on another user\'s conversation',
      should: 'return 403',
      actual: response.status,
      expected: 403,
    });
  });

  test('returns 200 on successful soft delete', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValue(existingConversation);
    const response = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    assert({
      given: 'a valid delete of an owned conversation',
      should: 'return 200 with the deleted conversation id',
      actual: response.status,
      expected: 200,
    });
  });

  test('soft delete calls db.update for the conversations table', async () => {
    vi.mocked(conversationRepository.getConversation).mockResolvedValue(existingConversation);
    await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    assert({
      given: 'a successful delete',
      should: 'call db.update at least once (to soft-delete the conversations row)',
      actual: vi.mocked(db.update).mock.calls.length >= 1,
      expected: true,
    });
  });

  test('returns 403 when scoped token deletes conversation outside its allowed drives', async () => {
    vi.mocked(getAllowedDriveIds).mockReturnValue(['drive-allowed']);
    vi.mocked(conversationRepository.getConversation).mockResolvedValue({
      ...existingConversation,
      contextId: 'drive-other',
    });
    const response = await DELETE(makeDeleteRequest(), { params: Promise.resolve({ id: 'conv-1' }) });
    assert({
      given: 'a scoped MCP token deleting a conversation tied to a different drive',
      should: 'return 403',
      actual: response.status,
      expected: 403,
    });
  });
});
