import { describe, it, expect } from 'vitest';
import {
  groupActivitiesForDiff,
  generateStackedDiff,
  truncateDiffsToTokenBudget,
  type ActivityForDiff,
  type StackedDiff,
} from '../content/activity-diff-utils';

describe('activity-diff-utils', () => {
  describe('groupActivitiesForDiff', () => {
    it('returns empty array for empty input', () => {
      const result = groupActivitiesForDiff([]);
      expect(result).toEqual([]);
    });

    it('groups activities by aiConversationId', () => {
      const activities: ActivityForDiff[] = [
        {
          id: '1',
          timestamp: '2024-01-01T10:00:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: null,
          aiConversationId: 'conv1',
          isAiGenerated: true,
          actorEmail: 'ai@example.com',
          actorDisplayName: 'AI Assistant',
          content: 'Content v1',
        },
        {
          id: '2',
          timestamp: '2024-01-01T10:01:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: null,
          aiConversationId: 'conv1',
          isAiGenerated: true,
          actorEmail: 'ai@example.com',
          actorDisplayName: 'AI Assistant',
          content: 'Content v2',
        },
        {
          id: '3',
          timestamp: '2024-01-01T10:02:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: null,
          aiConversationId: 'conv1',
          isAiGenerated: true,
          actorEmail: 'ai@example.com',
          actorDisplayName: 'AI Assistant',
          content: 'Content v3',
        },
      ];

      const result = groupActivitiesForDiff(activities);

      expect(result).toHaveLength(1);
      expect(result[0].activities).toHaveLength(3);
      expect(result[0].first.id).toBe('1');
      expect(result[0].last.id).toBe('3');
      expect(result[0].groupKey).toBe('ai:page1:conv1');
    });

    it('groups activities by changeGroupId when no aiConversationId', () => {
      const activities: ActivityForDiff[] = [
        {
          id: '1',
          timestamp: '2024-01-01T10:00:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: 'cg1',
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Content v1',
        },
        {
          id: '2',
          timestamp: '2024-01-01T10:01:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: 'cg1',
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Content v2',
        },
      ];

      const result = groupActivitiesForDiff(activities);

      expect(result).toHaveLength(1);
      expect(result[0].activities).toHaveLength(2);
      expect(result[0].groupKey).toBe('cg:page1:cg1');
    });

    it('creates separate groups for different pages', () => {
      const activities: ActivityForDiff[] = [
        {
          id: '1',
          timestamp: '2024-01-01T10:00:00Z',
          pageId: 'page1',
          resourceTitle: 'Page 1',
          changeGroupId: 'cg1',
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Page 1 content',
        },
        {
          id: '2',
          timestamp: '2024-01-01T10:01:00Z',
          pageId: 'page2',
          resourceTitle: 'Page 2',
          changeGroupId: 'cg1',
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Page 2 content',
        },
      ];

      const result = groupActivitiesForDiff(activities);

      expect(result).toHaveLength(2);
    });

    it('creates single-activity groups for ungrouped activities', () => {
      const activities: ActivityForDiff[] = [
        {
          id: '1',
          timestamp: '2024-01-01T10:00:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: null,
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Content',
        },
      ];

      const result = groupActivitiesForDiff(activities);

      expect(result).toHaveLength(1);
      expect(result[0].activities).toHaveLength(1);
      expect(result[0].groupKey).toBe('single:1');
    });

    it('skips activities without pageId', () => {
      const activities: ActivityForDiff[] = [
        {
          id: '1',
          timestamp: '2024-01-01T10:00:00Z',
          pageId: null,
          resourceTitle: 'Non-page resource',
          changeGroupId: 'cg1',
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Content',
        },
      ];

      const result = groupActivitiesForDiff(activities);

      expect(result).toHaveLength(0);
    });

    it('sorts activities by timestamp and picks correct first/last', () => {
      const activities: ActivityForDiff[] = [
        {
          id: '3',
          timestamp: '2024-01-01T10:02:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: 'cg1',
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Latest',
        },
        {
          id: '1',
          timestamp: '2024-01-01T10:00:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: 'cg1',
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Oldest',
        },
        {
          id: '2',
          timestamp: '2024-01-01T10:01:00Z',
          pageId: 'page1',
          resourceTitle: 'Test Page',
          changeGroupId: 'cg1',
          aiConversationId: null,
          isAiGenerated: false,
          actorEmail: 'user@example.com',
          actorDisplayName: 'User',
          content: 'Middle',
        },
      ];

      const result = groupActivitiesForDiff(activities);

      expect(result).toHaveLength(1);
      expect(result[0].first.id).toBe('1');
      expect(result[0].first.content).toBe('Oldest');
      expect(result[0].last.id).toBe('3');
      expect(result[0].last.content).toBe('Latest');
    });
  });

  describe('generateStackedDiff', () => {
    const createMockGroup = (overrides: Partial<{
      firstId: string;
      lastId: string;
      pageId: string;
      title: string;
      changeGroupId: string | null;
      aiConversationId: string | null;
      isAiGenerated: boolean;
    }> = {}) => {
      const first: ActivityForDiff = {
        id: overrides.firstId ?? '1',
        timestamp: '2024-01-01T10:00:00Z',
        pageId: overrides.pageId ?? 'page1',
        resourceTitle: overrides.title ?? 'Test Page',
        changeGroupId: overrides.changeGroupId ?? null,
        aiConversationId: overrides.aiConversationId ?? null,
        isAiGenerated: overrides.isAiGenerated ?? false,
        actorEmail: 'user@example.com',
        actorDisplayName: 'User',
        content: null,
      };

      const last: ActivityForDiff = {
        id: overrides.lastId ?? '2',
        timestamp: '2024-01-01T10:05:00Z',
        pageId: overrides.pageId ?? 'page1',
        resourceTitle: overrides.title ?? 'Test Page',
        changeGroupId: overrides.changeGroupId ?? null,
        aiConversationId: overrides.aiConversationId ?? null,
        isAiGenerated: overrides.isAiGenerated ?? false,
        actorEmail: 'user@example.com',
        actorDisplayName: 'User',
        content: null,
      };

      return {
        first,
        last,
        activities: [first, last],
        groupKey: 'test',
      };
    };

    it('returns null when both contents are null', () => {
      const group = createMockGroup();
      const result = generateStackedDiff(null, null, group);

      expect(result).toBeNull();
    });

    it('returns null when both contents are empty strings', () => {
      const group = createMockGroup();
      const result = generateStackedDiff('', '', group);

      expect(result).toBeNull();
    });

    it('returns null when contents are identical', () => {
      const group = createMockGroup();
      const result = generateStackedDiff('Same content', 'Same content', group);

      expect(result).toBeNull();
    });

    it('generates diff for content changes', () => {
      const group = createMockGroup({ pageId: 'page1', title: 'My Page' });
      const result = generateStackedDiff('Hello World', 'Hello Universe', group);

      expect(result).not.toBeNull();
      expect(result!.pageId).toBe('page1');
      expect(result!.pageTitle).toBe('My Page');
      expect(result!.unifiedDiff).toContain('---');
      expect(result!.unifiedDiff).toContain('+++');
      expect(result!.collapsedCount).toBe(2);
    });

    it('includes time range in result', () => {
      const group = createMockGroup();
      const result = generateStackedDiff('Before', 'After', group);

      expect(result).not.toBeNull();
      expect(result!.timeRange.from).toBe('2024-01-01T10:00:00Z');
      expect(result!.timeRange.to).toBe('2024-01-01T10:05:00Z');
    });

    it('includes unique actors in result', () => {
      const group = createMockGroup();
      group.activities = [
        { ...group.first, actorDisplayName: 'Alice' },
        { ...group.last, actorDisplayName: 'Bob' },
        { ...group.last, id: '3', actorDisplayName: 'Alice' }, // Duplicate
      ];

      const result = generateStackedDiff('Before', 'After', group);

      expect(result).not.toBeNull();
      expect(result!.actors).toHaveLength(2);
      expect(result!.actors).toContain('Alice');
      expect(result!.actors).toContain('Bob');
    });

    it('marks isAiGenerated if any activity is AI-generated', () => {
      const group = createMockGroup({ isAiGenerated: true });
      const result = generateStackedDiff('Before', 'After', group);

      expect(result).not.toBeNull();
      expect(result!.isAiGenerated).toBe(true);
    });

    it('handles creation (null to content)', () => {
      const group = createMockGroup();
      const result = generateStackedDiff(null, 'New content', group);

      expect(result).not.toBeNull();
      expect(result!.stats.additions).toBeGreaterThan(0);
    });

    it('handles deletion (content to null)', () => {
      const group = createMockGroup();
      const result = generateStackedDiff('Old content', null, group);

      expect(result).not.toBeNull();
      expect(result!.stats.deletions).toBeGreaterThan(0);
    });

    it('handles very large content with stats-only output', () => {
      const largeContent = 'x'.repeat(60 * 1024); // 60KB
      const group = createMockGroup();
      const result = generateStackedDiff('Small', largeContent, group);

      expect(result).not.toBeNull();
      expect(result!.unifiedDiff).toContain('too large');
      expect(result!.stats.additions).toBeGreaterThan(0);
    });
  });

  describe('truncateDiffsToTokenBudget', () => {
    const createMockDiff = (
      pageId: string,
      diffSize: number,
      additions: number = 100,
      deletions: number = 50
    ): StackedDiff => ({
      pageId,
      pageTitle: `Page ${pageId}`,
      changeGroupId: null,
      aiConversationId: null,
      collapsedCount: 1,
      timeRange: { from: '2024-01-01T10:00:00Z', to: '2024-01-01T10:05:00Z' },
      actors: ['user@example.com'],
      unifiedDiff: 'x'.repeat(diffSize),
      stats: { additions, deletions, unchanged: 0, totalChanges: 1 },
      isAiGenerated: false,
    });

    it('returns empty array for empty input', () => {
      const result = truncateDiffsToTokenBudget([]);
      expect(result).toEqual([]);
    });

    it('returns all diffs when within budget', () => {
      const diffs = [
        createMockDiff('page1', 100),
        createMockDiff('page2', 100),
      ];

      const result = truncateDiffsToTokenBudget(diffs, 50000, 10000);

      expect(result).toHaveLength(2);
    });

    it('prioritizes diffs with more changes', () => {
      const diffs = [
        createMockDiff('small', 1000, 10, 5),    // Small changes
        createMockDiff('large', 1000, 500, 300), // Large changes
      ];

      const result = truncateDiffsToTokenBudget(diffs, 1500, 10000);

      // Should include the large-change diff first
      expect(result[0].pageId).toBe('large');
    });

    it('truncates individual diffs that exceed per-page limit', () => {
      const diffs = [
        createMockDiff('page1', 15000), // Exceeds 10k limit
      ];

      const result = truncateDiffsToTokenBudget(diffs, 50000, 10000);

      expect(result).toHaveLength(1);
      expect(result[0].unifiedDiff.length).toBeLessThanOrEqual(10000);
      expect(result[0].unifiedDiff).toContain('truncated');
    });

    it('drops diffs when over total budget', () => {
      const diffs = [
        createMockDiff('page1', 3000, 500, 400),  // Highest priority
        createMockDiff('page2', 3000, 100, 100),  // Medium priority
        createMockDiff('page3', 3000, 50, 50),    // Lowest priority
      ];

      const result = truncateDiffsToTokenBudget(diffs, 5000, 10000);

      // Should only include highest priority diff(s) that fit
      expect(result.length).toBeLessThan(3);
      expect(result[0].pageId).toBe('page1');
    });

    it('includes partial diff for remaining budget', () => {
      const diffs = [
        createMockDiff('page1', 3000, 500, 400),
        createMockDiff('page2', 3000, 100, 100),
      ];

      const result = truncateDiffsToTokenBudget(diffs, 4500, 10000);

      // Should include first diff fully and second partially
      expect(result.length).toBe(2);
      expect(result[1].unifiedDiff.length).toBeLessThan(3000);
    });
  });
});
