import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

/**
 * Integration Service Tests
 *
 * The integration service evaluates raw insights from discovery against
 * the user's current personalization profile. It decides whether to
 * append, skip, or reorganize content.
 *
 * Key behaviors to test:
 * 1. Returns skip decisions when insufficient insights
 * 2. Evaluates insights against current profile
 * 3. Returns append decisions with content when new insights found
 * 4. Handles provider errors gracefully
 * 5. Applies integration decisions to update personalization
 */

// Mock database
const mockDbQuery = vi.fn();
const mockDbInsert = vi.fn();
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      userPersonalization: {
        findFirst: () => mockDbQuery(),
      },
    },
    insert: () => mockDbInsert(),
  },
  userPersonalization: { userId: 'userId' },
  eq: vi.fn(),
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

// Mock generateText
const mockGenerateText = vi.fn();
vi.mock('ai', () => ({
  generateText: () => mockGenerateText(),
}));

// Helper to set up AI provider success
function setupAIProviderSuccess(response: string) {
  mockCreateAIProvider.mockResolvedValue({
    model: 'test-model',
    provider: 'test',
    modelName: 'test',
  });
  mockGenerateText.mockResolvedValue({ text: response });
}

describe('integration-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue(null);
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    });
  });

  describe('evaluateAndIntegrate', () => {
    it('should exist and be callable', async () => {
      const { evaluateAndIntegrate } = await import('../integration-service');

      assert({
        given: 'integration-service module',
        should: 'export evaluateAndIntegrate function',
        actual: typeof evaluateAndIntegrate,
        expected: 'function',
      });
    });

    it('should return IntegrationDecision with three field decisions', async () => {
      setupAIProviderSuccess('{"bio":{"action":"skip"},"writingStyle":{"action":"skip"},"rules":{"action":"skip"}}');

      const { evaluateAndIntegrate } = await import('../integration-service');
      const insights = {
        worldview: ['Expert in TypeScript'],
        projects: ['Working on memory system'],
        communication: [],
        preferences: [],
      };

      const result = await evaluateAndIntegrate('user-123', insights, null);

      assert({
        given: 'insights and null personalization',
        should: 'return decision with bio field',
        actual: typeof result.bio,
        expected: 'object',
      });

      assert({
        given: 'insights and null personalization',
        should: 'return decision with writingStyle field',
        actual: typeof result.writingStyle,
        expected: 'object',
      });

      assert({
        given: 'insights and null personalization',
        should: 'return decision with rules field',
        actual: typeof result.rules,
        expected: 'object',
      });
    });

    it('should return skip decisions when insights total is below threshold', async () => {
      const { evaluateAndIntegrate } = await import('../integration-service');
      const insights = {
        worldview: ['Single insight'],
        projects: [],
        communication: [],
        preferences: [],
      };

      const result = await evaluateAndIntegrate('user-123', insights, null);

      assert({
        given: 'only 1 insight (below threshold of 2)',
        should: 'return skip for bio',
        actual: result.bio.action,
        expected: 'skip',
      });

      assert({
        given: 'only 1 insight (below threshold of 2)',
        should: 'return skip for writingStyle',
        actual: result.writingStyle.action,
        expected: 'skip',
      });

      assert({
        given: 'only 1 insight (below threshold of 2)',
        should: 'return skip for rules',
        actual: result.rules.action,
        expected: 'skip',
      });
    });

    it('should call LLM when sufficient insights exist', async () => {
      setupAIProviderSuccess('{"bio":{"action":"append","content":"Expert in TypeScript"},"writingStyle":{"action":"skip"},"rules":{"action":"skip"}}');

      const { evaluateAndIntegrate } = await import('../integration-service');
      const insights = {
        worldview: ['Expert in TypeScript', 'Values TDD'],
        projects: [],
        communication: [],
        preferences: [],
      };

      await evaluateAndIntegrate('user-123', insights, null);

      assert({
        given: '2+ insights',
        should: 'call LLM to evaluate',
        actual: mockGenerateText.mock.calls.length,
        expected: 1,
      });
    });

    it('should return append decision with content from LLM', async () => {
      setupAIProviderSuccess('{"bio":{"action":"append","content":"Expert in TypeScript"},"writingStyle":{"action":"skip"},"rules":{"action":"skip"}}');

      const { evaluateAndIntegrate } = await import('../integration-service');
      const insights = {
        worldview: ['Expert in TypeScript', 'Values TDD'],
        projects: [],
        communication: [],
        preferences: [],
      };

      const result = await evaluateAndIntegrate('user-123', insights, null);

      assert({
        given: 'LLM returns append decision',
        should: 'return append action for bio',
        actual: result.bio.action,
        expected: 'append',
      });

      assert({
        given: 'LLM returns append decision',
        should: 'return content for bio',
        actual: result.bio.content,
        expected: 'Expert in TypeScript',
      });
    });

    it('should handle markdown code block JSON responses', async () => {
      setupAIProviderSuccess('```json\n{"bio":{"action":"append","content":"Expert in TypeScript"},"writingStyle":{"action":"skip"},"rules":{"action":"skip"}}\n```');

      const { evaluateAndIntegrate } = await import('../integration-service');
      const insights = {
        worldview: ['Expert in TypeScript', 'Values TDD'],
        projects: [],
        communication: [],
        preferences: [],
      };

      const result = await evaluateAndIntegrate('user-123', insights, null);

      assert({
        given: 'LLM returns markdown code block',
        should: 'parse JSON and return append action',
        actual: result.bio.action,
        expected: 'append',
      });
    });

    it('should return skip decisions when AI provider fails', async () => {
      mockCreateAIProvider.mockResolvedValue({
        error: 'API key not configured',
        status: 400,
      });

      const { evaluateAndIntegrate } = await import('../integration-service');
      const insights = {
        worldview: ['Expert in TypeScript', 'Values TDD'],
        projects: [],
        communication: [],
        preferences: [],
      };

      const result = await evaluateAndIntegrate('user-123', insights, null);

      assert({
        given: 'AI provider error',
        should: 'return skip decisions without throwing',
        actual: result.bio.action,
        expected: 'skip',
      });
    });
  });

  describe('applyIntegrationDecisions', () => {
    it('should exist and be callable', async () => {
      const { applyIntegrationDecisions } = await import('../integration-service');

      assert({
        given: 'integration-service module',
        should: 'export applyIntegrationDecisions function',
        actual: typeof applyIntegrationDecisions,
        expected: 'function',
      });
    });

    it('should return updated: false when all decisions are skip', async () => {
      const { applyIntegrationDecisions } = await import('../integration-service');
      const decisions = {
        bio: { action: 'skip' as const },
        writingStyle: { action: 'skip' as const },
        rules: { action: 'skip' as const },
      };

      const result = await applyIntegrationDecisions('user-123', decisions, null);

      assert({
        given: 'all skip decisions',
        should: 'return updated: false',
        actual: result.updated,
        expected: false,
      });

      assert({
        given: 'all skip decisions',
        should: 'return empty fields array',
        actual: result.fields,
        expected: [],
      });
    });

    it('should return updated: true and list fields when append decisions applied', async () => {
      const { applyIntegrationDecisions } = await import('../integration-service');
      const decisions = {
        bio: { action: 'append' as const, content: 'Expert in TypeScript' },
        writingStyle: { action: 'skip' as const },
        rules: { action: 'append' as const, content: 'No emojis' },
      };

      const result = await applyIntegrationDecisions('user-123', decisions, null);

      assert({
        given: 'append decisions for bio and rules',
        should: 'return updated: true',
        actual: result.updated,
        expected: true,
      });

      assert({
        given: 'append decisions for bio and rules',
        should: 'return fields array with bio and rules',
        actual: result.fields,
        expected: ['bio', 'rules'],
      });
    });

    it('should append to existing content with double newline separator', async () => {
      const { applyIntegrationDecisions } = await import('../integration-service');
      const decisions = {
        bio: { action: 'append' as const, content: 'New insight' },
        writingStyle: { action: 'skip' as const },
        rules: { action: 'skip' as const },
      };
      const currentPersonalization = {
        bio: 'Existing bio',
        writingStyle: '',
        rules: '',
        enabled: true,
      };

      // Capture what gets passed to updatePersonalization
      let capturedBio = '';
      mockDbInsert.mockReturnValue({
        values: vi.fn((values) => {
          capturedBio = values.bio;
          return {
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          };
        }),
      });

      await applyIntegrationDecisions('user-123', decisions, currentPersonalization);

      assert({
        given: 'append decision with existing bio',
        should: 'append with double newline separator',
        actual: capturedBio,
        expected: 'Existing bio\n\nNew insight',
      });
    });
  });

  describe('getCurrentPersonalization', () => {
    it('should exist and be callable', async () => {
      const { getCurrentPersonalization } = await import('../integration-service');

      assert({
        given: 'integration-service module',
        should: 'export getCurrentPersonalization function',
        actual: typeof getCurrentPersonalization,
        expected: 'function',
      });
    });

    it('should return null when no personalization record exists', async () => {
      mockDbQuery.mockResolvedValue(null);

      const { getCurrentPersonalization } = await import('../integration-service');
      const result = await getCurrentPersonalization('user-123');

      assert({
        given: 'no personalization record',
        should: 'return null',
        actual: result,
        expected: null,
      });
    });

    it('should return personalization data when record exists', async () => {
      mockDbQuery.mockResolvedValue({
        bio: 'Test bio',
        writingStyle: 'Concise',
        rules: 'No emojis',
        enabled: true,
      });

      const { getCurrentPersonalization } = await import('../integration-service');
      const result = await getCurrentPersonalization('user-123');

      assert({
        given: 'existing personalization record',
        should: 'return personalization data',
        actual: result,
        expected: {
          bio: 'Test bio',
          writingStyle: 'Concise',
          rules: 'No emojis',
          enabled: true,
        },
      });
    });
  });
});
