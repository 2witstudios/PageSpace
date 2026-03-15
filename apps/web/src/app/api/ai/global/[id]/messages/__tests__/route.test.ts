/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/ai/global/[id]/messages
//
// Tests the GET handler (message retrieval with pagination) and
// POST handler's validation/error paths (streaming internals are not unit-tested).
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  conversations: {
    id: 'id',
    userId: 'userId',
    isActive: 'isActive',
  },
  messages: {
    id: 'id',
    conversationId: 'conversationId',
    isActive: 'isActive',
    createdAt: 'createdAt',
    role: 'role',
    content: 'content',
  },
  drives: {},
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/ai/core', () => ({
  convertGlobalAssistantMessageToUIMessage: vi.fn((msg: any) => ({
    id: msg.id,
    role: msg.role,
    parts: [{ type: 'text', text: msg.content }],
    createdAt: msg.createdAt,
  })),
  createAIProvider: vi.fn(),
  updateUserProviderSettings: vi.fn(),
  createProviderErrorResponse: vi.fn(),
  isProviderError: vi.fn(),
  pageSpaceTools: {},
  extractMessageContent: vi.fn((m: any) => m.content || ''),
  extractToolCalls: vi.fn(),
  extractToolResults: vi.fn(),
  sanitizeMessagesForModel: vi.fn(),
  saveGlobalAssistantMessageToDatabase: vi.fn(),
  processMentionsInMessage: vi.fn(() => ({ mentions: [], pageIds: [] })),
  buildMentionSystemPrompt: vi.fn(),
  buildTimestampSystemPrompt: vi.fn(() => ''),
  buildSystemPrompt: vi.fn(() => ''),
  buildAgentAwarenessPrompt: vi.fn(() => ''),
  filterToolsForReadOnly: vi.fn(),
  filterToolsForWebSearch: vi.fn(),
  getPageTreeContext: vi.fn(),
  getDriveListSummary: vi.fn(),
  getModelCapabilities: vi.fn(),
  convertMCPToolsToAISDKSchemas: vi.fn(),
  parseMCPToolName: vi.fn(),
  sanitizeToolNamesForProvider: vi.fn(),
  getUserPersonalization: vi.fn(),
  getUserTimezone: vi.fn(),
}));

vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  getPageSpaceModelTier: vi.fn(),
}));

vi.mock('@/lib/ai/core/tool-utils', () => ({
  mergeToolSets: vi.fn(),
}));

vi.mock('@/lib/subscription/usage-service', () => ({
  incrementUsage: vi.fn(),
  getCurrentUsage: vi.fn(),
  getUserUsageSummary: vi.fn(),
}));

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  createRateLimitResponse: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastUsageEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      })),
    },
    ai: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
}));

vi.mock('@/lib/mcp', () => ({
  getMCPBridge: vi.fn(),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

vi.mock('@pagespace/lib/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
}));

vi.mock('@pagespace/lib/ai-context-calculator', () => ({
  calculateTotalContextSize: vi.fn(() => 0),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

vi.mock('@/lib/utils/query-params', () => ({
  parseBoundedIntParam: vi.fn((raw: string | null, opts: { defaultValue: number }) => {
    if (!raw) return opts.defaultValue;
    const n = parseInt(raw, 10);
    return isNaN(n) ? opts.defaultValue : Math.min(opts.max ?? 200, Math.max(opts.min ?? 1, n));
  }),
}));

vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  createStreamAbortController: vi.fn(),
  removeStream: vi.fn(),
  STREAM_ID_HEADER: 'x-stream-id',
}));

vi.mock('@/lib/ai/core/validate-image-parts', () => ({
  validateUserMessageFileParts: vi.fn(() => ({ valid: true })),
  hasFileParts: vi.fn(() => false),
}));

vi.mock('@/lib/ai/core/model-capabilities', () => ({
  hasVisionCapability: vi.fn(() => true),
}));

vi.mock('ai', () => ({
  streamText: vi.fn(),
  convertToModelMessages: vi.fn(() => []),
  stepCountIs: vi.fn(),
  createUIMessageStream: vi.fn(),
  createUIMessageStreamResponse: vi.fn(),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { convertGlobalAssistantMessageToUIMessage } from '@/lib/ai/core';
import { hasFileParts, validateUserMessageFileParts } from '@/lib/ai/core/validate-image-parts';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import { GET, POST } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createMockMessage = (overrides: Partial<{
  id: string;
  conversationId: string;
  userId: string;
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
  createdAt: Date;
  isActive: boolean;
  editedAt: Date | null;
}> = {}) => ({
  id: overrides.id ?? 'msg_1',
  conversationId: overrides.conversationId ?? 'conv_1',
  userId: overrides.userId ?? 'user_1',
  role: overrides.role ?? 'user',
  content: overrides.content ?? 'Hello',
  toolCalls: overrides.toolCalls ?? null,
  toolResults: overrides.toolResults ?? null,
  createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00Z'),
  isActive: overrides.isActive ?? true,
  editedAt: overrides.editedAt ?? null,
});

const mockConversation = {
  id: 'conv_1',
  userId: 'user_1',
  title: 'Test Conversation',
  isActive: true,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

// Chainable DB mock helper — the chain is both chainable AND awaitable (thenable),
// because some route code does `await db.select().from().where()` without .limit().
function createChainMock(resolvedValue: unknown = []) {
  const chain: any = {};
  ['from', 'where', 'orderBy', 'limit', 'set', 'returning', 'values'].forEach(m => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  // Make the chain thenable so `await chain.from().where()` resolves to resolvedValue
  chain.then = (resolve: any, reject: any) => Promise.resolve(resolvedValue).then(resolve, reject);
  return chain;
}

// ============================================================================
// GET /api/ai/global/[id]/messages - Tests
// ============================================================================

describe('GET /api/ai/global/[id]/messages', () => {
  const userId = 'user_1';
  const conversationId = 'conv_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(userId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/ai/global/conv_1/messages');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(401);
  });

  it('should return 404 when conversation not found', async () => {
    const chain = createChainMock([]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Conversation not found');
  });

  it('should return 404 when conversation belongs to different user', async () => {
    // First select for conversation check returns empty (no match on userId)
    const chain = createChainMock([]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    const request = new Request('https://example.com/api/ai/global/conv_other/messages');
    const response = await GET(request, { params: Promise.resolve({ id: 'conv_other' }) });

    expect(response.status).toBe(404);
  });

  it('should return messages in chronological order', async () => {
    const msg1 = createMockMessage({ id: 'msg_1', createdAt: new Date('2024-01-01T00:00:00Z') });
    const msg2 = createMockMessage({ id: 'msg_2', role: 'assistant', content: 'Hi!', createdAt: new Date('2024-01-01T00:01:00Z') });

    // First select: conversation lookup
    const convChain = createChainMock([mockConversation]);
    // Second select: cursor lookup (not called when no cursor)
    // Third select: messages (returned in DESC order, so msg2, msg1)
    const msgChain = createChainMock([msg2, msg1]);

    vi.mocked(db.select)
      .mockReturnValueOnce(convChain as any)
      .mockReturnValueOnce(msgChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toHaveLength(2);
    // Messages should be reversed (chronological: oldest first)
    expect(convertGlobalAssistantMessageToUIMessage).toHaveBeenCalledTimes(2);
  });

  it('should return pagination info with hasMore=false when no more messages', async () => {
    const msg1 = createMockMessage({ id: 'msg_1' });

    const convChain = createChainMock([mockConversation]);
    const msgChain = createChainMock([msg1]); // Only 1 message, limit defaults to 50

    vi.mocked(db.select)
      .mockReturnValueOnce(convChain as any)
      .mockReturnValueOnce(msgChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    const body = await response.json();
    expect(body.pagination.hasMore).toBe(false);
    expect(body.pagination.nextCursor).toBeNull();
    expect(body.pagination.limit).toBe(50);
    expect(body.pagination.direction).toBe('before');
  });

  it('should return hasMore=true when more messages exist', async () => {
    // With limit=1, return 2 messages to indicate hasMore
    const msg1 = createMockMessage({ id: 'msg_1', createdAt: new Date('2024-01-01T00:00:00Z') });
    const msg2 = createMockMessage({ id: 'msg_2', createdAt: new Date('2024-01-01T00:01:00Z') });

    const convChain = createChainMock([mockConversation]);
    const msgChain = createChainMock([msg2, msg1]); // 2 messages returned for limit=1

    vi.mocked(db.select)
      .mockReturnValueOnce(convChain as any)
      .mockReturnValueOnce(msgChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages?limit=1');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    const body = await response.json();
    expect(body.pagination.hasMore).toBe(true);
    expect(body.pagination.nextCursor).toBeDefined();
  });

  it('should handle cursor-based pagination with before direction', async () => {
    const cursorMsg = createMockMessage({ id: 'cursor_msg', createdAt: new Date('2024-01-02') });
    const olderMsg = createMockMessage({ id: 'older_msg', createdAt: new Date('2024-01-01') });

    const convChain = createChainMock([mockConversation]);
    const cursorChain = createChainMock([cursorMsg]);
    const msgChain = createChainMock([olderMsg]);

    vi.mocked(db.select)
      .mockReturnValueOnce(convChain as any)
      .mockReturnValueOnce(cursorChain as any)
      .mockReturnValueOnce(msgChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages?cursor=cursor_msg&direction=before');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(200);
  });

  it('should handle cursor-based pagination with after direction', async () => {
    const cursorMsg = createMockMessage({ id: 'cursor_msg', createdAt: new Date('2024-01-01') });
    const newerMsg = createMockMessage({ id: 'newer_msg', createdAt: new Date('2024-01-02') });

    const convChain = createChainMock([mockConversation]);
    const cursorChain = createChainMock([cursorMsg]);
    const msgChain = createChainMock([newerMsg]);

    vi.mocked(db.select)
      .mockReturnValueOnce(convChain as any)
      .mockReturnValueOnce(cursorChain as any)
      .mockReturnValueOnce(msgChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages?cursor=cursor_msg&direction=after');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(200);
  });

  it('should skip cursor filter when cursor message not found', async () => {
    const convChain = createChainMock([mockConversation]);
    const cursorChain = createChainMock([]); // Cursor not found
    const msgChain = createChainMock([createMockMessage()]);

    vi.mocked(db.select)
      .mockReturnValueOnce(convChain as any)
      .mockReturnValueOnce(cursorChain as any)
      .mockReturnValueOnce(msgChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages?cursor=nonexistent');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(200);
  });

  it('should return empty messages for empty conversation', async () => {
    const convChain = createChainMock([mockConversation]);
    const msgChain = createChainMock([]);

    vi.mocked(db.select)
      .mockReturnValueOnce(convChain as any)
      .mockReturnValueOnce(msgChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    const body = await response.json();
    expect(body.messages).toEqual([]);
    expect(body.pagination.hasMore).toBe(false);
    expect(body.pagination.nextCursor).toBeNull();
    expect(body.pagination.prevCursor).toBeNull();
  });

  it('should return 500 when database query fails', async () => {
    // First db.select: conversation lookup succeeds
    const convChain = createChainMock([mockConversation]);
    vi.mocked(db.select).mockReturnValueOnce(convChain as any);

    // Second db.select: messages query throws
    const errorChain = createChainMock([]);
    errorChain.then = (resolve: any, reject: any) =>
      Promise.reject(new Error('DB connection lost')).then(resolve, reject);
    vi.mocked(db.select).mockReturnValueOnce(errorChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages');
    const response = await GET(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Failed to fetch messages');
  });
});

// ============================================================================
// POST /api/ai/global/[id]/messages - Validation Tests
// ============================================================================

describe('POST /api/ai/global/[id]/messages', () => {
  const userId = 'user_1';
  const conversationId = 'conv_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(userId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(hasFileParts).mockReturnValue(false);
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/ai/global/conv_1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(401);
  });

  it('should return 404 when conversation not found', async () => {
    const chain = createChainMock([]);
    vi.mocked(db.select).mockReturnValue(chain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Conversation not found');
  });

  it('should return 413 when request body too large', async () => {
    const convChain = createChainMock([mockConversation]);
    vi.mocked(db.select).mockReturnValue(convChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages', {
      method: 'POST',
      headers: { 'content-length': String(30 * 1024 * 1024) }, // 30MB
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toContain('too large');
  });

  it('should return 400 when no messages provided', async () => {
    const convChain = createChainMock([mockConversation]);
    vi.mocked(db.select).mockReturnValue(convChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('messages are required');
  });

  it('should return 400 when messages field is missing', async () => {
    const convChain = createChainMock([mockConversation]);
    vi.mocked(db.select).mockReturnValue(convChain as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await POST(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(400);
  });

  it('should return 400 when image validation fails', async () => {
    const convChain = createChainMock([mockConversation]);
    vi.mocked(db.select).mockReturnValue(convChain as any);
    vi.mocked(hasFileParts).mockReturnValue(true);
    vi.mocked(validateUserMessageFileParts).mockReturnValue({
      valid: false,
      error: 'Invalid image format',
    } as any);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Look at this image', parts: [{ type: 'file' }] }],
      }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid image format');
  });

  it('should return 400 when images sent to non-vision model', async () => {
    const convChain = createChainMock([mockConversation]);
    vi.mocked(db.select).mockReturnValue(convChain as any);
    vi.mocked(hasFileParts).mockReturnValue(true);
    vi.mocked(validateUserMessageFileParts).mockReturnValue({ valid: true } as any);
    vi.mocked(hasVisionCapability).mockReturnValue(false);

    const request = new Request('https://example.com/api/ai/global/conv_1/messages', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Look at this', parts: [{ type: 'file' }] }],
        selectedModel: 'text-only-model',
      }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: conversationId }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('does not support image attachments');
  });
});
