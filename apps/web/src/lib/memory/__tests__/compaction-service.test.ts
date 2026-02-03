import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

/**
 * Compaction Service Tests
 *
 * The compaction service handles reorganizing and summarizing personalization
 * fields when they grow too large. It uses LLM to preserve key insights while
 * reducing size.
 *
 * Key behaviors to test:
 * 1. needsCompaction detects when content exceeds threshold
 * 2. compactField reduces content size while preserving meaning
 * 3. checkAndCompactIfNeeded processes all fields needing compaction
 * 4. Handles LLM errors gracefully (returns original content)
 * 5. Doesn't compact if result would be larger
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

describe('compaction-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue(null);
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    });
  });

  describe('needsCompaction', () => {
    it('should exist and be callable', async () => {
      const { needsCompaction } = await import('../compaction-service');

      assert({
        given: 'compaction-service module',
        should: 'export needsCompaction function',
        actual: typeof needsCompaction,
        expected: 'function',
      });
    });

    it('should return false for content below threshold', async () => {
      const { needsCompaction } = await import('../compaction-service');
      const shortContent = 'Short bio';

      const result = needsCompaction(shortContent, 20000);

      assert({
        given: 'content below 90% of max length',
        should: 'return false',
        actual: result,
        expected: false,
      });
    });

    it('should return true for content at or above 90% threshold', async () => {
      const { needsCompaction } = await import('../compaction-service');
      // 90% of 1000 = 900, so 901 should trigger
      const longContent = 'x'.repeat(901);

      const result = needsCompaction(longContent, 1000);

      assert({
        given: 'content at 90.1% of max length',
        should: 'return true',
        actual: result,
        expected: true,
      });
    });

    it('should use default max length of 20000 if not specified', async () => {
      const { needsCompaction } = await import('../compaction-service');
      // 90% of 20000 = 18000, so 17999 should not trigger
      const justUnderContent = 'x'.repeat(17999);
      const justOverContent = 'x'.repeat(18001);

      assert({
        given: 'content at 17999 chars (under 90% of 20000)',
        should: 'return false',
        actual: needsCompaction(justUnderContent),
        expected: false,
      });

      assert({
        given: 'content at 18001 chars (over 90% of 20000)',
        should: 'return true',
        actual: needsCompaction(justOverContent),
        expected: true,
      });
    });
  });

  describe('compactField', () => {
    it('should exist and be callable', async () => {
      const { compactField } = await import('../compaction-service');

      assert({
        given: 'compaction-service module',
        should: 'export compactField function',
        actual: typeof compactField,
        expected: 'function',
      });
    });

    it('should return compacted content from LLM', async () => {
      setupAIProviderSuccess('Compacted bio content');

      const { compactField } = await import('../compaction-service');
      const longContent = 'Original long bio content that needs compacting';

      const result = await compactField('user-123', 'bio', longContent, 1000);

      assert({
        given: 'long content and successful LLM response',
        should: 'return compacted content',
        actual: result,
        expected: 'Compacted bio content',
      });
    });

    it('should return original content when LLM returns empty', async () => {
      setupAIProviderSuccess('');

      const { compactField } = await import('../compaction-service');
      const originalContent = 'Original content';

      const result = await compactField('user-123', 'bio', originalContent, 1000);

      assert({
        given: 'LLM returns empty response',
        should: 'return original content',
        actual: result,
        expected: originalContent,
      });
    });

    it('should return original content when LLM returns longer text', async () => {
      const originalContent = 'Short';
      setupAIProviderSuccess('This is actually longer than the original');

      const { compactField } = await import('../compaction-service');

      const result = await compactField('user-123', 'bio', originalContent, 1000);

      assert({
        given: 'LLM returns longer text than original',
        should: 'return original content',
        actual: result,
        expected: originalContent,
      });
    });

    it('should return original content when AI provider fails', async () => {
      mockCreateAIProvider.mockResolvedValue({
        error: 'API key not configured',
        status: 400,
      });

      const { compactField } = await import('../compaction-service');
      const originalContent = 'Original content that needs compacting';

      const result = await compactField('user-123', 'bio', originalContent, 1000);

      assert({
        given: 'AI provider error',
        should: 'return original content without throwing',
        actual: result,
        expected: originalContent,
      });
    });

    it('should call LLM with field-specific system prompt', async () => {
      setupAIProviderSuccess('Compacted');

      const { compactField } = await import('../compaction-service');
      await compactField('user-123', 'bio', 'Long content', 1000);

      assert({
        given: 'compactField called with bio field',
        should: 'call generateText once',
        actual: mockGenerateText.mock.calls.length,
        expected: 1,
      });
    });
  });

  describe('checkAndCompactIfNeeded', () => {
    it('should exist and be callable', async () => {
      const { checkAndCompactIfNeeded } = await import('../compaction-service');

      assert({
        given: 'compaction-service module',
        should: 'export checkAndCompactIfNeeded function',
        actual: typeof checkAndCompactIfNeeded,
        expected: 'function',
      });
    });

    it('should return compacted: false when no personalization exists', async () => {
      mockDbQuery.mockResolvedValue(null);

      const { checkAndCompactIfNeeded } = await import('../compaction-service');
      const result = await checkAndCompactIfNeeded('user-123');

      assert({
        given: 'no personalization record',
        should: 'return compacted: false',
        actual: result.compacted,
        expected: false,
      });

      assert({
        given: 'no personalization record',
        should: 'return empty fields array',
        actual: result.fields,
        expected: [],
      });
    });

    it('should return compacted: false when all fields are under threshold', async () => {
      mockDbQuery.mockResolvedValue({
        bio: 'Short bio',
        writingStyle: 'Concise',
        rules: 'No rules',
        enabled: true,
      });

      const { checkAndCompactIfNeeded } = await import('../compaction-service');
      const result = await checkAndCompactIfNeeded('user-123', 20000);

      assert({
        given: 'all fields under threshold',
        should: 'return compacted: false',
        actual: result.compacted,
        expected: false,
      });
    });

    it('should compact fields exceeding threshold', async () => {
      // Bio exceeds threshold, others don't
      const longBio = 'x'.repeat(950);
      mockDbQuery.mockResolvedValue({
        bio: longBio,
        writingStyle: 'Short',
        rules: 'Short',
        enabled: true,
      });
      setupAIProviderSuccess('Compacted bio');

      const { checkAndCompactIfNeeded } = await import('../compaction-service');
      const result = await checkAndCompactIfNeeded('user-123', 1000);

      assert({
        given: 'bio field exceeds threshold',
        should: 'return compacted: true',
        actual: result.compacted,
        expected: true,
      });

      assert({
        given: 'only bio exceeds threshold',
        should: 'return fields array with bio',
        actual: result.fields,
        expected: ['bio'],
      });
    });

    it('should compact multiple fields if multiple exceed threshold', async () => {
      const longContent = 'x'.repeat(950);
      mockDbQuery.mockResolvedValue({
        bio: longContent,
        writingStyle: longContent,
        rules: 'Short',
        enabled: true,
      });
      setupAIProviderSuccess('Compacted');

      const { checkAndCompactIfNeeded } = await import('../compaction-service');
      const result = await checkAndCompactIfNeeded('user-123', 1000);

      assert({
        given: 'bio and writingStyle exceed threshold',
        should: 'return compacted: true',
        actual: result.compacted,
        expected: true,
      });

      assert({
        given: 'bio and writingStyle exceed threshold',
        should: 'return both fields in array',
        actual: result.fields.sort(),
        expected: ['bio', 'writingStyle'].sort(),
      });
    });
  });
});
