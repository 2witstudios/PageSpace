import { describe, it, expect } from 'vitest';
import {
  generateDiffsWithinBudget,
  estimateChangeMagnitude,
  calculateDiffBudget,
  type DiffBudget,
  type DiffRequest,
} from '../content/diff-generator';
import type { ActivityForDiff, ActivityDiffGroup } from '../content/activity-diff-utils';

describe('diff-generator', () => {
  // Helper to create a mock activity diff group
  const createMockGroup = (overrides: Partial<{
    pageId: string;
    title: string;
    actorCount: number;
  }> = {}): ActivityDiffGroup => {
    const first: ActivityForDiff = {
      id: '1',
      timestamp: '2024-01-01T10:00:00Z',
      pageId: overrides.pageId ?? 'page1',
      resourceTitle: overrides.title ?? 'Test Page',
      changeGroupId: 'cg1',
      aiConversationId: null,
      isAiGenerated: false,
      actorEmail: 'user@example.com',
      actorDisplayName: 'User',
      content: null,
    };

    const last: ActivityForDiff = {
      ...first,
      id: '2',
      timestamp: '2024-01-01T10:05:00Z',
    };

    return {
      first,
      last,
      activities: [first, last],
      groupKey: `test:${overrides.pageId ?? 'page1'}`,
    };
  };

  describe('estimateChangeMagnitude', () => {
    it('returns content length for new content (null -> something)', () => {
      const magnitude = estimateChangeMagnitude(null, 'Hello World');
      expect(magnitude).toBe(11); // "Hello World".length
    });

    it('returns content length for deleted content (something -> null)', () => {
      const magnitude = estimateChangeMagnitude('Hello World', null);
      expect(magnitude).toBe(11);
    });

    it('returns weighted magnitude for modifications', () => {
      const magnitude = estimateChangeMagnitude('Hello', 'Hello World');
      // lengthDiff = 6, avgLen = 8, weighted = 6 + sqrt(8) ≈ 8.83
      expect(magnitude).toBeGreaterThan(6);
      expect(magnitude).toBeLessThan(10);
    });

    it('handles both null inputs', () => {
      const magnitude = estimateChangeMagnitude(null, null);
      expect(magnitude).toBe(0);
    });

    it('handles empty strings', () => {
      const magnitude = estimateChangeMagnitude('', '');
      expect(magnitude).toBe(0);
    });
  });

  describe('calculateDiffBudget', () => {
    it('allocates 40% of output to total diff budget', () => {
      const budget = calculateDiffBudget(10000);
      expect(budget.total).toBe(4000);
    });

    it('allocates 10% of output to per-item budget', () => {
      const budget = calculateDiffBudget(10000);
      expect(budget.perItem).toBe(1000);
    });

    it('sets minimum useful size', () => {
      const budget = calculateDiffBudget(10000);
      expect(budget.minUseful).toBe(200);
    });

    it('scales with different output sizes', () => {
      const smallBudget = calculateDiffBudget(5000);
      const largeBudget = calculateDiffBudget(50000);

      expect(largeBudget.total).toBe(smallBudget.total * 10);
      expect(largeBudget.perItem).toBe(smallBudget.perItem * 10);
    });
  });

  describe('generateDiffsWithinBudget', () => {
    it('returns empty array for empty input', () => {
      const budget: DiffBudget = { total: 10000, perItem: 2000 };
      const result = generateDiffsWithinBudget([], budget);
      expect(result).toEqual([]);
    });

    it('generates diffs for valid requests', () => {
      const budget: DiffBudget = { total: 10000, perItem: 2000 };
      const requests: DiffRequest[] = [
        {
          pageId: 'page1',
          beforeContent: 'Hello',
          afterContent: 'Hello World',
          group: createMockGroup({ pageId: 'page1' }),
          driveId: 'drive1',
        },
      ];

      const result = generateDiffsWithinBudget(requests, budget);

      expect(result).toHaveLength(1);
      expect(result[0].pageId).toBe('page1');
      expect(result[0].driveId).toBe('drive1');
      expect(result[0].unifiedDiff).toBeDefined();
    });

    it('skips requests with no meaningful diff', () => {
      const budget: DiffBudget = { total: 10000, perItem: 2000 };
      const requests: DiffRequest[] = [
        {
          pageId: 'page1',
          beforeContent: 'Same content',
          afterContent: 'Same content', // Identical
          group: createMockGroup({ pageId: 'page1' }),
          driveId: 'drive1',
        },
      ];

      const result = generateDiffsWithinBudget(requests, budget);

      expect(result).toHaveLength(0);
    });

    it('prioritizes larger changes', () => {
      const budget: DiffBudget = { total: 500, perItem: 400, minUseful: 100 };

      const requests: DiffRequest[] = [
        {
          pageId: 'small',
          beforeContent: 'A',
          afterContent: 'AB', // Small change
          group: createMockGroup({ pageId: 'small', title: 'Small' }),
          driveId: 'drive1',
          priority: 10,
        },
        {
          pageId: 'large',
          beforeContent: '',
          afterContent: 'x'.repeat(100), // Large change
          group: createMockGroup({ pageId: 'large', title: 'Large' }),
          driveId: 'drive1',
          priority: 100,
        },
      ];

      const result = generateDiffsWithinBudget(requests, budget);

      // Should include large change first due to higher priority
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].pageId).toBe('large');
    });

    it('respects total budget limit', () => {
      const budget: DiffBudget = { total: 500, perItem: 1000, minUseful: 50 };

      // Create multiple requests that would exceed budget
      const requests: DiffRequest[] = [];
      for (let i = 0; i < 10; i++) {
        requests.push({
          pageId: `page${i}`,
          beforeContent: '',
          afterContent: 'x'.repeat(100),
          group: createMockGroup({ pageId: `page${i}` }),
          driveId: 'drive1',
        });
      }

      const result = generateDiffsWithinBudget(requests, budget);

      // Total diff content should be within budget
      const totalChars = result.reduce((sum, d) => sum + d.unifiedDiff.length, 0);
      expect(totalChars).toBeLessThanOrEqual(budget.total);
    });

    it('respects per-item budget limit', () => {
      const budget: DiffBudget = { total: 50000, perItem: 200, minUseful: 50 };

      const requests: DiffRequest[] = [
        {
          pageId: 'page1',
          beforeContent: '',
          afterContent: 'x'.repeat(500), // Would generate large diff
          group: createMockGroup({ pageId: 'page1' }),
          driveId: 'drive1',
        },
      ];

      const result = generateDiffsWithinBudget(requests, budget);

      expect(result).toHaveLength(1);
      expect(result[0].unifiedDiff.length).toBeLessThanOrEqual(budget.perItem);
      expect(result[0].unifiedDiff).toContain('truncated');
    });

    it('stops when remaining budget is below minUseful', () => {
      // Use a very small budget that can only fit one medium-sized diff
      const budget: DiffBudget = { total: 150, perItem: 150, minUseful: 100 };

      // Create requests with meaningful content that generates larger diffs
      const requests: DiffRequest[] = [
        {
          pageId: 'page1',
          beforeContent: 'First line\nSecond line',
          afterContent: 'First line modified\nSecond line changed',
          group: createMockGroup({ pageId: 'page1' }),
          driveId: 'drive1',
        },
        {
          pageId: 'page2',
          beforeContent: 'Another document\nWith content',
          afterContent: 'Another document\nWith different content',
          group: createMockGroup({ pageId: 'page2' }),
          driveId: 'drive1',
        },
        {
          pageId: 'page3',
          beforeContent: 'Third page\nMore text',
          afterContent: 'Third page\nEven more text',
          group: createMockGroup({ pageId: 'page3' }),
          driveId: 'drive1',
        },
      ];

      const result = generateDiffsWithinBudget(requests, budget);

      // With a tiny budget, should stop after first diff consumes most of it
      // The exact number depends on diff size, but should be less than all 3
      expect(result.length).toBeLessThan(3);
    });

    it('includes driveId in output', () => {
      const budget: DiffBudget = { total: 10000, perItem: 2000 };
      const requests: DiffRequest[] = [
        {
          pageId: 'page1',
          beforeContent: 'Before',
          afterContent: 'After',
          group: createMockGroup({ pageId: 'page1' }),
          driveId: 'my-drive-123',
        },
      ];

      const result = generateDiffsWithinBudget(requests, budget);

      expect(result[0].driveId).toBe('my-drive-123');
    });

    it('uses explicit priority when provided', () => {
      const budget: DiffBudget = { total: 500, perItem: 400, minUseful: 100 };

      const requests: DiffRequest[] = [
        {
          pageId: 'low',
          beforeContent: '',
          afterContent: 'x'.repeat(100), // Actually large content
          group: createMockGroup({ pageId: 'low', title: 'Low Priority' }),
          driveId: 'drive1',
          priority: 1, // But low priority
        },
        {
          pageId: 'high',
          beforeContent: 'A',
          afterContent: 'B', // Small content
          group: createMockGroup({ pageId: 'high', title: 'High Priority' }),
          driveId: 'drive1',
          priority: 1000, // High priority
        },
      ];

      const result = generateDiffsWithinBudget(requests, budget);

      // High priority should come first despite smaller change
      expect(result[0].pageId).toBe('high');
    });
  });
});
