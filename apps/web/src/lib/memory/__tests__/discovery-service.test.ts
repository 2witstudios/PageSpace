import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

/**
 * Discovery Service Tests
 *
 * The discovery service runs focused LLM passes to extract insights from
 * user conversations. It is "blind" - it does NOT see the current profile.
 *
 * Key behaviors to test:
 * 1. Returns empty results when insufficient conversation data
 * 2. Runs 4 focused passes (worldview, projects, communication, preferences)
 * 3. Parses JSON array responses from LLM
 * 4. Handles LLM errors gracefully (returns empty arrays, doesn't throw)
 * 5. Gathers conversations from multiple sources
 */

// Mock database - we don't want to hit real DB
const mockDbSelect = vi.fn();
vi.mock('@pagespace/db', () => ({
  db: {
    select: () => mockDbSelect(),
  },
  conversations: { id: 'id', userId: 'userId' },
  messages: { content: 'content', role: 'role', conversationId: 'conversationId', isActive: 'isActive', createdAt: 'createdAt' },
  chatMessages: { content: 'content', role: 'role', pageId: 'pageId', userId: 'userId', isActive: 'isActive', createdAt: 'createdAt' },
  pages: { id: 'id', driveId: 'driveId' },
  activityLogs: { operation: 'operation', resourceType: 'resourceType', resourceTitle: 'resourceTitle', userId: 'userId', driveId: 'driveId', timestamp: 'timestamp' },
  driveMembers: { driveId: 'driveId', userId: 'userId' },
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

// Mock AI provider
const mockCreateAIProvider = vi.fn();
vi.mock('@/lib/ai/core', () => ({
  createAIProvider: () => mockCreateAIProvider(),
  isProviderError: (result: unknown) => result !== null && typeof result === 'object' && 'error' in result,
}));

// Mock loggers
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

// Mock generateText from AI SDK
const mockGenerateText = vi.fn();
vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

// Helper to set up DB mock to return messages
function setupDbWithMessages(messageCount: number) {
  const now = Date.now();
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    content: `Message ${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    createdAt: new Date(now - i * 1000),
  }));

  // Chain for messages query
  const messagesChain = {
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(messages)),
          })),
        })),
      })),
    })),
  };

  // Chain for driveMembers query (returns empty - no drives)
  const driveMembersChain = {
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
  };

  let callCount = 0;
  mockDbSelect.mockImplementation(() => {
    callCount++;
    // First call is for messages, second for driveMembers
    if (callCount === 1) return messagesChain;
    return driveMembersChain;
  });
}

// Helper to set up AI provider success with specific response
function setupAIProviderSuccess(responses: string[]) {
  mockCreateAIProvider.mockResolvedValue({
    model: 'test-model',
    provider: 'test',
    modelName: 'test',
  });

  let callIndex = 0;
  mockGenerateText.mockImplementation(() => {
    const response = responses[callIndex % responses.length];
    callIndex++;
    return Promise.resolve({ text: response });
  });
}

describe('discovery-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: setup DB to return empty (insufficient data)
    setupDbWithMessages(0);
  });

  describe('runDiscoveryPasses', () => {
    it('should exist and be callable', async () => {
      const { runDiscoveryPasses } = await import('../discovery-service');

      assert({
        given: 'discovery-service module',
        should: 'export runDiscoveryPasses function',
        actual: typeof runDiscoveryPasses,
        expected: 'function',
      });
    });

    it('should return DiscoveryResult with four arrays', async () => {
      const { runDiscoveryPasses } = await import('../discovery-service');

      const result = await runDiscoveryPasses('user-123');

      assert({
        given: 'a userId',
        should: 'return result with worldview array',
        actual: Array.isArray(result.worldview),
        expected: true,
      });

      assert({
        given: 'a userId',
        should: 'return result with projects array',
        actual: Array.isArray(result.projects),
        expected: true,
      });

      assert({
        given: 'a userId',
        should: 'return result with communication array',
        actual: Array.isArray(result.communication),
        expected: true,
      });

      assert({
        given: 'a userId',
        should: 'return result with preferences array',
        actual: Array.isArray(result.preferences),
        expected: true,
      });
    });

    it('should return empty arrays when user has insufficient conversations', async () => {
      // Default mock returns empty arrays (no conversations)
      setupDbWithMessages(0);
      const { runDiscoveryPasses } = await import('../discovery-service');

      const result = await runDiscoveryPasses('user-with-no-data');

      assert({
        given: 'a user with fewer than 3 conversations',
        should: 'return empty worldview array',
        actual: result.worldview,
        expected: [],
      });

      assert({
        given: 'a user with fewer than 3 conversations',
        should: 'return empty projects array',
        actual: result.projects,
        expected: [],
      });
    });
  });

  describe('DiscoveryResult type', () => {
    it('should define DiscoveryResult interface', async () => {
      // Type check - if this compiles, the type exists
      const { runDiscoveryPasses } = await import('../discovery-service');
      const result = await runDiscoveryPasses('test');

      // TypeScript will fail compilation if these properties don't exist
      const _worldview: string[] = result.worldview;
      const _projects: string[] = result.projects;
      const _communication: string[] = result.communication;
      const _preferences: string[] = result.preferences;

      assert({
        given: 'DiscoveryResult',
        should: 'have string array types for all fields',
        actual: true,
        expected: true,
      });
    });
  });

  describe('LLM integration', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should run 4 LLM passes when sufficient conversations exist', async () => {
      setupDbWithMessages(10);
      setupAIProviderSuccess([
        '["Expert in TypeScript"]',
        '["Working on memory system"]',
        '["Prefers concise responses"]',
        '["No emojis please"]',
      ]);

      const { runDiscoveryPasses } = await import('../discovery-service');
      const result = await runDiscoveryPasses('user-with-data');

      // Should have called generateText 4 times (one per pass)
      assert({
        given: 'user with sufficient conversations',
        should: 'call LLM 4 times for 4 discovery passes',
        actual: mockGenerateText.mock.calls.length,
        expected: 4,
      });
    });

    it('should parse JSON array responses from LLM', async () => {
      setupDbWithMessages(10);
      setupAIProviderSuccess([
        '["Expert in TypeScript", "Values TDD"]',
        '["Working on memory system"]',
        '["Prefers concise responses"]',
        '["No emojis please"]',
      ]);

      const { runDiscoveryPasses } = await import('../discovery-service');
      const result = await runDiscoveryPasses('user-with-data');

      assert({
        given: 'LLM returns JSON array for worldview',
        should: 'parse and return insights',
        actual: result.worldview,
        expected: ['Expert in TypeScript', 'Values TDD'],
      });
    });

    it('should handle markdown code block JSON responses', async () => {
      setupDbWithMessages(10);
      setupAIProviderSuccess([
        '```json\n["Expert in TypeScript"]\n```',
        '["Working on memory system"]',
        '["Prefers concise responses"]',
        '["No emojis"]',
      ]);

      const { runDiscoveryPasses } = await import('../discovery-service');
      const result = await runDiscoveryPasses('user-with-data');

      assert({
        given: 'LLM returns markdown code block with JSON',
        should: 'extract and parse the JSON',
        actual: result.worldview,
        expected: ['Expert in TypeScript'],
      });
    });

    it('should return empty array when LLM returns non-JSON', async () => {
      setupDbWithMessages(10);
      setupAIProviderSuccess([
        'I found some insights about this user',
        '["Working on memory system"]',
        '["Prefers concise responses"]',
        '["No emojis"]',
      ]);

      const { runDiscoveryPasses } = await import('../discovery-service');
      const result = await runDiscoveryPasses('user-with-data');

      assert({
        given: 'LLM returns non-JSON response',
        should: 'return empty array for that pass',
        actual: result.worldview,
        expected: [],
      });
    });

    it('should return empty arrays when AI provider fails', async () => {
      setupDbWithMessages(10);
      mockCreateAIProvider.mockResolvedValue({
        error: 'API key not configured',
        status: 400,
      });

      const { runDiscoveryPasses } = await import('../discovery-service');
      const result = await runDiscoveryPasses('user-with-data');

      assert({
        given: 'AI provider returns error',
        should: 'return empty arrays without throwing',
        actual: result.worldview,
        expected: [],
      });
    });

    it('should include recent page messages when context is limited to 100', async () => {
      const now = Date.now();
      const globalMessages = Array.from({ length: 150 }, (_, i) => ({
        content: `Global message ${i + 1}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        createdAt: new Date(now - (i + 50) * 1000),
      }));
      const pageMessages = [
        {
          content: 'Recent page message 1',
          role: 'user',
          createdAt: new Date(now - 1000),
        },
        {
          content: 'Recent page message 2',
          role: 'assistant',
          createdAt: new Date(now - 2000),
        },
      ];

      mockDbSelect.mockImplementation(() => {
        return {
          from: vi.fn((table: Record<string, unknown>) => {
            // messages table
            if ('conversationId' in table) {
              return {
                innerJoin: vi.fn(() => ({
                  where: vi.fn(() => ({
                    orderBy: vi.fn(() => ({
                      limit: vi.fn(() => Promise.resolve(globalMessages)),
                    })),
                  })),
                })),
              };
            }

            // chatMessages table
            if ('pageId' in table) {
              return {
                innerJoin: vi.fn(() => ({
                  where: vi.fn(() => ({
                    orderBy: vi.fn(() => ({
                      limit: vi.fn(() => Promise.resolve(pageMessages)),
                    })),
                  })),
                })),
              };
            }

            // activityLogs table
            if ('operation' in table) {
              return {
                where: vi.fn(() => ({
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(() => Promise.resolve([])),
                  })),
                })),
              };
            }

            // driveMembers table
            if ('driveId' in table && 'userId' in table) {
              return {
                where: vi.fn(() => Promise.resolve([{ driveId: 'drive-1' }])),
              };
            }

            return {
              where: vi.fn(() => Promise.resolve([])),
            };
          }),
        };
      });

      const { runDiscoveryPasses } = await import('../discovery-service');
      mockCreateAIProvider.mockResolvedValue({
        model: 'test-model',
        provider: 'test',
        modelName: 'test',
      });
      mockGenerateText.mockImplementation((payload: { messages?: Array<{ content?: string }> }) => {
        const prompt = payload.messages?.[0]?.content ?? '';
        return Promise.resolve({
          text: prompt.includes('Recent page message 1')
            ? '["Includes page context"]'
            : '[]',
        });
      });

      const result = await runDiscoveryPasses('user-with-page-messages');

      assert({
        given: 'recent page messages are newer than many global messages',
        should: 'include recent page messages in limited LLM context',
        actual: result.worldview,
        expected: ['Includes page context'],
      });
    });
  });
});
