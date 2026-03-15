/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for POST /api/ai/page-agents/consult
//
// Tests the agent consultation endpoint that uses AI to generate responses
// from a specific page agent. Mocks AI SDK and DB calls.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  pages: { id: 'id', type: 'type' },
  drives: { id: 'id' },
  chatMessages: { pageId: 'pageId', createdAt: 'createdAt' },
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPPageScope: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    ai: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
}));

vi.mock('ai', () => ({
  convertToModelMessages: vi.fn(() => []),
  generateText: vi.fn().mockResolvedValue({
    text: 'Agent response text',
    steps: [],
    usage: { inputTokens: 10, outputTokens: 20 },
  }),
  stepCountIs: vi.fn(),
}));

vi.mock('@/lib/ai/core', () => ({
  createAIProvider: vi.fn().mockResolvedValue({ model: 'mock-model' }),
  isProviderError: vi.fn(() => false),
  pageSpaceTools: { tool1: {} },
  buildTimestampSystemPrompt: vi.fn(() => 'Timestamp prompt'),
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { createAIProvider, isProviderError } from '@/lib/ai/core';
import { generateText } from 'ai';
import { POST } from '../route';

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

const mockAgent = {
  id: 'agent_1',
  title: 'Test Agent',
  type: 'AI_CHAT',
  driveId: 'drive_1',
  systemPrompt: 'You are a helpful agent.',
  enabledTools: ['tool1'],
  aiProvider: 'openai',
  aiModel: 'gpt-4',
  content: '',
  isTrashed: false,
};

const mockDrive = {
  id: 'drive_1',
  name: 'Test Drive',
  slug: 'test-drive',
};

function createChainMock(resolvedValue: unknown = []) {
  const chain: any = {};
  ['from', 'where', 'orderBy', 'limit'].forEach(m => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  chain.then = (resolve: any, reject: any) => Promise.resolve(resolvedValue).then(resolve, reject);
  return chain;
}

/** Set up db.select to return agent, drive, and messages in sequence. */
function setupDbSelectForConsultation(
  agent: unknown = mockAgent,
  drive: unknown = mockDrive,
  msgs: unknown[] = []
) {
  vi.mocked(db.select).mockReset();
  const agentChain = createChainMock([agent]);
  const driveChain = createChainMock([drive]);
  const messagesChain = createChainMock(msgs);
  vi.mocked(db.select)
    .mockReturnValueOnce(agentChain as any)
    .mockReturnValueOnce(driveChain as any)
    .mockReturnValueOnce(messagesChain as any);
}

function makeRequest(body: object) {
  return new Request('https://example.com/api/ai/page-agents/consult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ============================================================================
// POST /api/ai/page-agents/consult - Tests
// ============================================================================

describe('POST /api/ai/page-agents/consult', () => {
  const userId = 'user_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(userId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null as any);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    vi.mocked(isProviderError).mockReturnValue(false);
    vi.mocked(createAIProvider).mockResolvedValue({ model: 'mock-model' } as any);
    vi.mocked(generateText).mockResolvedValue({
      text: 'Agent response text',
      steps: [],
      usage: { inputTokens: 10, outputTokens: 20 },
    } as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(makeRequest({ agentId: 'agent_1', question: 'Hello' }));
      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when agentId is missing', async () => {
      const response = await POST(makeRequest({ question: 'Hello' }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('agentId and question are required');
    });

    it('should return 400 when question is missing', async () => {
      const response = await POST(makeRequest({ agentId: 'agent_1' }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('agentId and question are required');
    });

    it('should return 404 when agent not found', async () => {
      const chain = createChainMock([]);
      vi.mocked(db.select).mockReturnValue(chain as any);

      const response = await POST(makeRequest({ agentId: 'agent_1', question: 'Hello' }));
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toContain('not found');
    });

    it('should return 400 when page is not AI_CHAT type', async () => {
      const nonAgentPage = { ...mockAgent, type: 'DOCUMENT' };
      const chain = createChainMock([nonAgentPage]);
      vi.mocked(db.select).mockReturnValue(chain as any);

      const response = await POST(makeRequest({ agentId: 'agent_1', question: 'Hello' }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('not an AI agent');
    });
  });

  describe('authorization', () => {
    it('should return MCP scope error when scope check fails', async () => {
      const agentChain = createChainMock([mockAgent]);
      vi.mocked(db.select).mockReturnValue(agentChain as any);
      vi.mocked(checkMCPPageScope).mockResolvedValue(
        NextResponse.json({ error: 'Out of scope' }, { status: 403 }) as any
      );

      const response = await POST(makeRequest({ agentId: 'agent_1', question: 'Hello' }));
      expect(response.status).toBe(403);
    });

    it('should return 403 when user lacks view permission', async () => {
      const agentChain = createChainMock([mockAgent]);
      const driveChain = createChainMock([mockDrive]);
      vi.mocked(db.select)
        .mockReturnValueOnce(agentChain as any)
        .mockReturnValueOnce(driveChain as any);
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await POST(makeRequest({ agentId: 'agent_1', question: 'Hello' }));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('Insufficient permissions');
    });
  });

  describe('successful consultation', () => {
    it('should return successful response with agent info', async () => {
      setupDbSelectForConsultation();

      const response = await POST(makeRequest({
        agentId: 'agent_1',
        question: 'What is PageSpace?',
      }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.agent.id).toBe('agent_1');
      expect(body.agent.title).toBe('Test Agent');
      expect(body.response).toBe('Agent response text');
      expect(body.question).toBe('What is PageSpace?');
    });

    it('should include context in consultation when provided', async () => {
      setupDbSelectForConsultation();

      const response = await POST(makeRequest({
        agentId: 'agent_1',
        question: 'Explain this',
        context: 'Some background info',
      }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.context).toBe('Some background info');
    });

    it('should return metadata with response', async () => {
      setupDbSelectForConsultation();

      const response = await POST(makeRequest({
        agentId: 'agent_1',
        question: 'Hello',
      }));

      const body = await response.json();
      expect(body.metadata).toBeDefined();
      expect(body.metadata.provider).toBe('openai');
      expect(body.metadata.model).toBe('gpt-4');
      expect(body.metadata.responseLength).toBeGreaterThan(0);
      expect(body.summary).toContain('Consulted agent');
      expect(body.nextSteps).toBeInstanceOf(Array);
    });
  });

  describe('AI provider errors', () => {
    it('should return 500 when AI provider setup fails', async () => {
      const agentChain = createChainMock([mockAgent]);
      const driveChain = createChainMock([mockDrive]);
      const messagesChain = createChainMock([]);

      vi.mocked(db.select)
        .mockReturnValueOnce(agentChain as any)
        .mockReturnValueOnce(driveChain as any)
        .mockReturnValueOnce(messagesChain as any);

      vi.mocked(isProviderError).mockReturnValue(true);
      vi.mocked(createAIProvider).mockResolvedValue({
        error: 'Provider not configured',
      } as any);

      const response = await POST(makeRequest({
        agentId: 'agent_1',
        question: 'Hello',
      }));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('Failed to configure AI provider');
    });

    it('should return 500 when AI generation fails', async () => {
      const agentChain = createChainMock([mockAgent]);
      const driveChain = createChainMock([mockDrive]);
      const messagesChain = createChainMock([]);

      vi.mocked(db.select)
        .mockReturnValueOnce(agentChain as any)
        .mockReturnValueOnce(driveChain as any)
        .mockReturnValueOnce(messagesChain as any);

      vi.mocked(generateText).mockRejectedValue(new Error('Model timeout'));

      const response = await POST(makeRequest({
        agentId: 'agent_1',
        question: 'Hello',
      }));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('Failed to generate response');
    });
  });

  describe('error handling', () => {
    it('should return 500 when unexpected error occurs', async () => {
      vi.mocked(db.select).mockReset();
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Unexpected database error');
      });

      const response = await POST(makeRequest({
        agentId: 'agent_1',
        question: 'Hello',
      }));

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('Failed to consult agent');
    });
  });
});
