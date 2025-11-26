import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn(),
      },
    },
    execute: vi.fn(),
  },
  pages: {},
  eq: vi.fn((field, value) => ({ field, value, type: 'eq' })),
  and: vi.fn((...args) => ({ args, type: 'and' })),
  sql: vi.fn((strings, ...values) => ({ strings, values, type: 'sql' })),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateHybridRequest: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new_conv_id_123'),
}));

import { db } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { authenticateHybridRequest, isAuthError } from '@/lib/auth';

describe('GET /api/agents/[agentId]/conversations/latest', () => {
  const mockUserId = 'user_123';
  const mockAgentId = 'abc123def456ghi789jkl012';

  const createContext = () => ({
    params: Promise.resolve({ agentId: mockAgentId }),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateHybridRequest).mockResolvedValue({
      userId: mockUserId,
    });
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: user can view page
    vi.mocked(canUserViewPage).mockResolvedValue(true);
  });

  it('should return 404 when agent not found', async () => {
    // Mock agent not found
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined);

    const request = new Request('https://example.com/api/agents/agent_abc123/conversations/latest');
    const response = await GET(request, createContext());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('AI agent not found');
  });

  it('should return latest conversation when exists', async () => {
    // Mock agent exists
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: mockAgentId,
      type: 'AI_CHAT',
      isTrashed: false,
    });

    // Mock existing conversation
    vi.mocked(db.execute).mockResolvedValue({
      rows: [{
        conversationId: 'conv_existing_123',
        firstMessageTime: new Date('2024-01-01'),
        lastMessageTime: new Date('2024-01-02'),
        messageCount: 5,
        firstUserMessage: JSON.stringify([{ text: 'Hello agent' }]),
      }],
    });

    const request = new Request('https://example.com/api/agents/agent_abc123/conversations/latest');
    const response = await GET(request, createContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe('conv_existing_123');
    expect(body.isNew).toBe(false);
    expect(body.messageCount).toBe(5);
    expect(body.title).toBe('Hello agent');
  });

  it('should create new conversation when none exist', async () => {
    // Mock agent exists
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({
      id: mockAgentId,
      type: 'AI_CHAT',
      isTrashed: false,
    });

    // Mock no existing conversations
    vi.mocked(db.execute).mockResolvedValue({
      rows: [],
    });

    const request = new Request('https://example.com/api/agents/agent_abc123/conversations/latest');
    const response = await GET(request, createContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe('new_conv_id_123');
    expect(body.isNew).toBe(true);
    expect(body.messageCount).toBe(0);
    expect(body.title).toBe('New conversation');
  });
});
